import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { moneroBase58Decode, moneroBase58Encode } from "./monero-base58.js";

// Monero crypto for v1 inbound detection. Pure TypeScript, no native deps —
// works on Node, Cloudflare Workers, and Vercel-Edge identically.
//
// Scope: address parsing, subaddress derivation under `account 0`, view-key
// cross-check (boot validation), output match against the gateway's
// subaddresses (shared-secret derivation), and RingCT v2 amount unblinding.
//
// Out of scope (deferred to v2 with payouts): tx construction, ring
// signatures, Bulletproofs, key images.
//
// References:
//   - Monero subaddress derivation: monero/src/cryptonote_basic/cryptonote_basic_impl.cpp
//   - Hs hash-to-scalar: monero/src/crypto/crypto.cpp
//   - RingCT amount encoding: monero/src/ringct/rctOps.cpp
//   - Address format: monero/src/cryptonote_basic/cryptonote_basic_impl.cpp:get_account_address_as_str
//
// Network bytes (the prefix byte before the keys in the encoded address):
//   mainnet  primary    = 0x12 (18)
//   mainnet  subaddress = 0x2A (42)
//   stagenet primary    = 0x18 (24)
//   stagenet subaddress = 0x24 (36)
//   testnet  primary    = 0x35 (53)
//   testnet  subaddress = 0x3F (63)

export type MoneroNetwork = "mainnet" | "stagenet" | "testnet";

export interface ParsedMoneroAddress {
  readonly network: MoneroNetwork;
  readonly isSubaddress: boolean;
  // 32-byte compressed ed25519 points.
  readonly publicSpendKey: Uint8Array;
  readonly publicViewKey: Uint8Array;
}

const NETWORK_BYTES: Readonly<
  Record<number, { network: MoneroNetwork; isSubaddress: boolean }>
> = {
  0x12: { network: "mainnet", isSubaddress: false },
  0x2a: { network: "mainnet", isSubaddress: true },
  0x18: { network: "stagenet", isSubaddress: false },
  0x24: { network: "stagenet", isSubaddress: true },
  0x35: { network: "testnet", isSubaddress: false },
  0x3f: { network: "testnet", isSubaddress: true }
};

const PRIMARY_NETWORK_BYTE: Readonly<Record<MoneroNetwork, number>> = {
  mainnet: 0x12,
  stagenet: 0x18,
  testnet: 0x35
};
const SUBADDRESS_NETWORK_BYTE: Readonly<Record<MoneroNetwork, number>> = {
  mainnet: 0x2a,
  stagenet: 0x24,
  testnet: 0x3f
};

// ed25519 group order ℓ = 2^252 + 27742317777372353535851937790883648493.
// Reduce hash-to-scalar mod this. (`@noble/curves` exposes `ed25519.Point.Fn.ORDER`.)
const ED25519_L: bigint = ed25519.Point.Fn.ORDER;

// Decode a Monero address (primary or subaddress) and return the network +
// the two public keys. Throws on malformed input — wrong checksum, unknown
// network byte, or wrong byte length.
//
// Address structure: <netByte:1> || <publicSpendKey:32> || <publicViewKey:32>
// || <checksum:4>, base58-encoded with Monero's split-block variant.
export function parseAddress(addrStr: string): ParsedMoneroAddress {
  let raw: Uint8Array;
  try {
    raw = moneroBase58Decode(addrStr);
  } catch (err) {
    throw new Error(`parseAddress: base58 decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.length !== 1 + 32 + 32 + 4) {
    throw new Error(`parseAddress: expected 69 bytes (netByte+spend+view+checksum), got ${raw.length}`);
  }
  const netByte = raw[0]!;
  const meta = NETWORK_BYTES[netByte];
  if (!meta) {
    throw new Error(`parseAddress: unknown network byte 0x${netByte.toString(16)}`);
  }
  const body = raw.subarray(0, 1 + 64);
  const checksumActual = raw.subarray(65, 69);
  const checksumExpected = keccak_256(body).subarray(0, 4);
  if (!constantTimeEqual(checksumActual, checksumExpected)) {
    throw new Error("parseAddress: checksum mismatch (corrupt address?)");
  }
  return {
    network: meta.network,
    isSubaddress: meta.isSubaddress,
    publicSpendKey: raw.subarray(1, 33),
    publicViewKey: raw.subarray(33, 65)
  };
}

// Encode (network, isSubaddress, spendPub, viewPub) → Monero base58 address.
export function encodeAddress(args: {
  network: MoneroNetwork;
  isSubaddress: boolean;
  publicSpendKey: Uint8Array;
  publicViewKey: Uint8Array;
}): string {
  if (args.publicSpendKey.length !== 32 || args.publicViewKey.length !== 32) {
    throw new Error("encodeAddress: spend/view keys must be 32 bytes each");
  }
  const netByte = args.isSubaddress
    ? SUBADDRESS_NETWORK_BYTE[args.network]
    : PRIMARY_NETWORK_BYTE[args.network];
  const body = new Uint8Array(1 + 64);
  body[0] = netByte;
  body.set(args.publicSpendKey, 1);
  body.set(args.publicViewKey, 33);
  const checksum = keccak_256(body).subarray(0, 4);
  const full = new Uint8Array(body.length + 4);
  full.set(body);
  full.set(checksum, body.length);
  return moneroBase58Encode(full);
}

// Hash-to-scalar (Monero's Hs): keccak-256(input), interpreted as a
// little-endian uint, reduced mod the ed25519 group order ℓ.
export function hashToScalar(input: Uint8Array): bigint {
  const h = keccak_256(input);
  return leBytesToBigIntMod(h, ED25519_L);
}

// Cryptonote-style varint (LEB128 with the high bit as continuation flag).
// Used for serializing account/subaddress indices into the SubAddr derivation
// preimage and for output indices in the shared-secret hash.
export function encodeVarint(n: bigint | number): Uint8Array {
  let v = typeof n === "bigint" ? n : BigInt(n);
  if (v < 0n) throw new Error("encodeVarint: negative value");
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

// Derive subaddress at (account, index) from the merchant's master view key
// + primary public spend key. Returns the encoded subaddress string.
//
// Algorithm (account/index encoded as little-endian uint32 each):
//   m_scalar = Hs("SubAddr\x00" || viewKeySecret || account_le32 || index_le32) mod ℓ
//   D = primarySpendPub + m_scalar · G   ← subaddress public spend key
//   C = viewKeySecret · D                 ← subaddress public view key
//   Encode (subaddress netByte, D, C) → base58 string.
//
// Index 0/0 is special — it's the merchant's primary address, NOT a
// subaddress. We disallow it here and require account=0, index>=1.
export function deriveSubaddress(args: {
  network: MoneroNetwork;
  viewKeySecret: Uint8Array; // 32-byte scalar (already reduced mod ℓ)
  primarySpendPub: Uint8Array; // 32-byte ed25519 point
  account: number; // u32
  index: number; // u32
}): string {
  if (args.viewKeySecret.length !== 32) {
    throw new Error("deriveSubaddress: viewKeySecret must be 32 bytes");
  }
  if (args.primarySpendPub.length !== 32) {
    throw new Error("deriveSubaddress: primarySpendPub must be 32 bytes");
  }
  if (args.account < 0 || args.index < 0) {
    throw new Error("deriveSubaddress: account and index must be non-negative");
  }
  if (args.account === 0 && args.index === 0) {
    throw new Error("deriveSubaddress: (0,0) is the primary address, not a subaddress");
  }
  // Preimage: "SubAddr\x00" (8 bytes incl. null terminator) || viewSecret(32)
  // || account(4 LE) || index(4 LE)
  const prefix = new Uint8Array([0x53, 0x75, 0x62, 0x41, 0x64, 0x64, 0x72, 0x00]); // 8 bytes: "SubAddr" + NUL terminator (0x00, NOT a space)
  const accBytes = u32LE(args.account);
  const idxBytes = u32LE(args.index);
  const preimage = new Uint8Array(prefix.length + 32 + 4 + 4);
  preimage.set(prefix, 0);
  preimage.set(args.viewKeySecret, prefix.length);
  preimage.set(accBytes, prefix.length + 32);
  preimage.set(idxBytes, prefix.length + 36);
  const m = hashToScalar(preimage);

  const D = ed25519.Point.fromBytes(args.primarySpendPub).add(
    ed25519.Point.BASE.multiply(m === 0n ? 1n : m)
  );
  const viewScalar = leBytesToBigIntMod(args.viewKeySecret, ED25519_L);
  const C = D.multiply(viewScalar === 0n ? 1n : viewScalar);

  return encodeAddress({
    network: args.network,
    isSubaddress: true,
    publicSpendKey: D.toBytes(),
    publicViewKey: C.toBytes()
  });
}

// Boot-time sanity check: the supplied secret view key must derive back to
// the public view key embedded in the primary address. Mismatch = the
// operator pasted the wrong key and we'd silently fail to decode any
// incoming output.
export function viewKeyMatchesAddress(
  viewKeySecret: Uint8Array,
  primaryAddress: string
): boolean {
  if (viewKeySecret.length !== 32) return false;
  const parsed = parseAddress(primaryAddress);
  if (parsed.isSubaddress) return false; // must be the primary, not a subaddress
  const scalar = leBytesToBigIntMod(viewKeySecret, ED25519_L);
  if (scalar === 0n) return false;
  const derived = ed25519.Point.BASE.multiply(scalar).toBytes();
  return constantTimeEqual(derived, parsed.publicViewKey);
}

// "Shared secret" — Monero's `derivation_to_scalar`. Two-stage:
//   1. derivation D = 8 · viewSecret · txPubkey  (32-byte point encoding).
//      The factor of 8 (cofactor) clears any small-subgroup component a
//      hostile sender might have planted in `txPubkey`.
//   2. scalar = Hs(D || varint(outputIndex))  (= keccak_256(...) mod ℓ).
// We return the 32 bytes that encode the reduced scalar — same value
// `expectedOutputPubkey` consumes (as a scalar to multiply G by) AND the
// amount-decoding hash consumes (as bytes alongside the "amount" salt).
// Bit-compatible with monero/src/crypto/crypto.cpp:hash_to_scalar.
export function deriveSharedSecret(args: {
  viewKeySecret: Uint8Array;
  txPubkey: Uint8Array; // 32-byte ed25519 point from the tx's `tx_pubkey`
  outputIndex: number; // 0-based index within the tx's output list
}): Uint8Array {
  const viewScalar = leBytesToBigIntMod(args.viewKeySecret, ED25519_L);
  if (viewScalar === 0n) {
    throw new Error("deriveSharedSecret: zero view scalar");
  }
  const txPub = ed25519.Point.fromBytes(args.txPubkey);
  const Dpoint = txPub.multiply(viewScalar).multiply(8n);
  const D = Dpoint.toBytes();
  const idx = encodeVarint(args.outputIndex);
  const preimage = new Uint8Array(D.length + idx.length);
  preimage.set(D, 0);
  preimage.set(idx, D.length);
  // sc_reduce32 — reduce the keccak output mod ℓ and re-encode as 32 LE bytes.
  const reduced = leBytesToBigIntMod(keccak_256(preimage), ED25519_L);
  return scalarToLEBytes32(reduced);
}

// For a given subaddress N owned by the merchant: compute the expected
// `output_pubkey` an incoming transfer to N would carry. Match against the
// actual `output_pubkey` to confirm the output belongs to that subaddress.
//
//   expected = sharedSecret · G + subaddressSpendPub_N
//
// `sharedSecret` is already a scalar (`deriveSharedSecret` did the
// hash-to-scalar reduction); we just decode the 32 LE bytes and multiply.
export function expectedOutputPubkey(args: {
  sharedSecret: Uint8Array;
  subaddressSpendPub: Uint8Array;
}): Uint8Array {
  const scalar = leBytesToBigIntMod(args.sharedSecret, ED25519_L);
  const safe = scalar === 0n ? 1n : scalar;
  const left = ed25519.Point.BASE.multiply(safe);
  const right = ed25519.Point.fromBytes(args.subaddressSpendPub);
  return left.add(right).toBytes();
}

// Unblind a RingCT v2 (BulletproofPlus) output amount.
//
// Sender encodes `amount` as `encryptedAmount = amount XOR Hs("amount" ||
// sharedSecret)[0..8]` (8 bytes — Monero amounts are uint64 atomic units).
// The recipient recovers it by computing the same hash and XORing.
//
// `encryptedAmount` is exactly 8 bytes (the modern v2 encoding); legacy v1
// 32-byte mask form is not supported here. Returns the amount in atomic
// units (piconero) as a bigint.
export function decodeRctAmount(args: {
  sharedSecret: Uint8Array;
  encryptedAmount: Uint8Array; // 8 bytes, hex-decoded from tx's `ecdhInfo[i].amount`
}): bigint {
  if (args.encryptedAmount.length !== 8) {
    throw new Error("decodeRctAmount: encryptedAmount must be 8 bytes (RingCT v2 encoding)");
  }
  const preimage = new Uint8Array("amount".length + args.sharedSecret.length);
  preimage.set(new TextEncoder().encode("amount"), 0);
  preimage.set(args.sharedSecret, "amount".length);
  const mask = keccak_256(preimage);
  let out = 0n;
  for (let i = 0; i < 8; i += 1) {
    const b = (args.encryptedAmount[i]! ^ mask[i]!) & 0xff;
    out |= BigInt(b) << BigInt(i * 8);
  }
  return out;
}

// ---- Internal helpers ----

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}

function leBytesToBigIntMod(bytes: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    n = (n << 8n) | BigInt(bytes[i]!);
  }
  return n % modulus;
}

function u32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

// Encode a scalar (already reduced mod ℓ) as 32 LE bytes — Monero's
// `ec_scalar` storage format, used by `derivation_to_scalar` and
// downstream amount-decoding.
function scalarToLEBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
