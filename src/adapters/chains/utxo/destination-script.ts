import { createBase58check, bech32, bech32m } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import type { UtxoChainConfig } from "./utxo-config.js";

// Decoders for every UTXO address type a merchant might hand us as a payout
// destination. Receive addresses we issue ourselves stay BIP84 native segwit
// only (see bech32-address.ts) — this module is strictly about the SEND side.
//
// Four families:
//   - P2PKH         (legacy, "1...")    base58check, scriptPubkey 76 a9 14 <h160> 88 ac
//   - P2SH          ("3..." / "M..."/"L...") base58check, scriptPubkey a9 14 <h160> 87
//   - P2WPKH (v0)   ("bc1q.../tb1q...") bech32,       scriptPubkey 00 14 <h160>
//   - P2WSH  (v0)   ("bc1q...64-char")  bech32,       scriptPubkey 00 20 <h256>
//   - P2TR   (v1)   ("bc1p...")         bech32m,      scriptPubkey 51 20 <xonly>
//
// Sending TO a P2WSH (script-hash) is rare for retail merchants but it costs
// nothing to support — same bech32 v0 path as P2WPKH, just with a 32-byte
// program. Taproot uses bech32m per BIP350 (different checksum constant);
// pre-taproot v0 addresses use bech32. Mixing the two checksums is a hard
// reject — that's the whole point of the BIP350 split.

const base58cd = createBase58check(sha256);

// Per-chain version-byte sets. Address-type derived from these:
//   p2pkh: <version> || <20-byte hash160>
//   p2sh:  <version> || <20-byte hash160>
//
// Litecoin notes:
//   - Mainnet P2SH originally used 0x05 (same as BTC). Around 2018 the LTC
//     project added 0x32 ("M..." prefix) to disambiguate from BTC P2SH,
//     and most wallets now issue 0x32. Old wallets can still produce 0x05
//     P2SH addresses, so we accept BOTH on LTC mainnet — they're equivalent
//     in spendability.
//   - Testnet has used 0x3a in some forks; we accept the standard 0xc4 only.
//     If field reports surface 0x3a we can extend the list.
interface AddressVersionBytes {
  // Possible leading byte(s) for a P2PKH address on this chain.
  readonly p2pkh: readonly number[];
  // Possible leading byte(s) for a P2SH address on this chain. Multiple
  // entries allowed (LTC mainnet ⇒ both 0x05 and 0x32).
  readonly p2sh: readonly number[];
}

function versionBytesForChain(slug: UtxoChainConfig["slug"]): AddressVersionBytes {
  switch (slug) {
    case "bitcoin":
      return { p2pkh: [0x00], p2sh: [0x05] };
    case "bitcoin-testnet":
      return { p2pkh: [0x6f], p2sh: [0xc4] };
    case "litecoin":
      // Both 0x05 (legacy P2SH, BTC-shared) and 0x32 (LTC-specific "M..." prefix).
      return { p2pkh: [0x30], p2sh: [0x05, 0x32] };
    case "litecoin-testnet":
      // BTC testnet (0x6f / 0xc4) and LTC testnet share these version bytes by
      // design — slip-0044 puts every testnet under coin_type=1. An address
      // string alone CANNOT distinguish "BTC testnet" from "LTC testnet";
      // the chain context is supplied by the invoice/payout's chainId, never
      // inferred from address shape. Callers must pass the right chain to
      // decodeUtxoDestination — feeding a BTC-testnet P2PKH against the
      // LTC-testnet config will decode successfully (the bytes are identical)
      // but the network it's spent on is determined by chainId, not address.
      return { p2pkh: [0x6f], p2sh: [0xc4] };
  }
}

export type DecodedAddress =
  | { readonly type: "p2pkh"; readonly hash160: Uint8Array }
  | { readonly type: "p2sh"; readonly hash160: Uint8Array }
  | { readonly type: "p2wpkh"; readonly program: Uint8Array }   // 20 bytes
  | { readonly type: "p2wsh"; readonly program: Uint8Array }    // 32 bytes
  | { readonly type: "p2tr"; readonly program: Uint8Array };    // 32 bytes (x-only pubkey)

// Top-level decode: try bech32m (v1+) first, then bech32 (v0), then base58check.
// Each branch is mutually exclusive — a valid bech32 string is not a valid
// base58 string. Returns null on any malformed/unrecognized input; payout
// validation surfaces this as a clean rejection.
export function decodeUtxoDestination(
  address: string,
  chain: UtxoChainConfig
): DecodedAddress | null {
  // BIP173 forbids mixed-case bech32 strings; reject any input that contains
  // both uppercase and lowercase letters BEFORE handing to the bech32 decoder
  // (which accepts pure-upper or pure-lower silently). Base58 is
  // case-sensitive and naturally mixed-case, so this guard only applies to
  // bech32-shaped inputs.
  const lower = address.toLowerCase();
  const upper = address.toUpperCase();
  const looksBech32 = lower.startsWith(chain.bech32Hrp + "1");
  if (looksBech32 && address !== lower && address !== upper) {
    return null;
  }

  if (looksBech32) {
    return decodeBech32Address(lower, chain);
  }

  // Base58check branch (legacy + P2SH).
  return decodeBase58Address(address, chain);
}

function decodeBech32Address(
  lower: string,
  chain: UtxoChainConfig
): DecodedAddress | null {
  // Peek the witness version: 5 bits of the first data char after the
  // separator. We can't know the version without decoding, so try bech32m
  // first (v1+ uses bech32m exclusively per BIP350); on its failure fall
  // back to bech32 (v0 only). The two checksums use different constants,
  // so a v0 program decoded with bech32m fails its checksum and vice versa
  // — that's the safety property.
  let parsed: { prefix: string; words: number[] } | null = null;
  let usedBech32m = false;
  try {
    parsed = bech32m.decode(lower as `${string}1${string}`);
    usedBech32m = true;
  } catch {
    try {
      parsed = bech32.decode(lower as `${string}1${string}`);
    } catch {
      return null;
    }
  }
  // BIP173: mixed-case forms MUST NOT be accepted. @scure/base accepts
  // pure-uppercase or pure-lowercase, but the caller already lowercased
  // for HRP detection. We re-check the original (passed in `lower` here
  // which IS already lowercase) — the actual mixed-case rejection happens
  // in `decodeUtxoDestination` before we ever reach this branch.
  if (parsed.prefix !== chain.bech32Hrp) return null;
  if (parsed.words.length === 0) return null;

  const version = parsed.words[0]!;
  let program: Uint8Array;
  try {
    program = (usedBech32m ? bech32m : bech32).fromWords(parsed.words.slice(1));
  } catch {
    return null;
  }

  // BIP141 segwit constraints:
  //   - Program length: 2..40 bytes
  //   - v0 must be exactly 20 (P2WPKH) or 32 (P2WSH) bytes, encoded as bech32
  //   - v1+ uses bech32m; v1 P2TR is exactly 32 bytes (x-only pubkey)
  //   - All other versions/lengths are reserved/unused on mainnet
  if (program.length < 2 || program.length > 40) return null;

  if (version === 0) {
    // BIP173: v0 MUST be bech32 (not bech32m).
    if (usedBech32m) return null;
    if (program.length === 20) return { type: "p2wpkh", program };
    if (program.length === 32) return { type: "p2wsh", program };
    return null;
  }

  if (version === 1) {
    // BIP350: v1+ MUST be bech32m.
    if (!usedBech32m) return null;
    if (program.length !== 32) return null;
    return { type: "p2tr", program };
  }

  // v2..v16 are reserved for future segwit upgrades — reject for now;
  // sending coins to an unrecognized witness version is a permanent burn
  // until the network activates that version.
  return null;
}

function decodeBase58Address(
  address: string,
  chain: UtxoChainConfig
): DecodedAddress | null {
  let payload: Uint8Array;
  try {
    payload = base58cd.decode(address);
  } catch {
    return null;
  }
  // base58check payload is [version_byte(s), hash160(20)]. We only support
  // single-byte version prefixes (all current BTC/LTC P2PKH/P2SH variants
  // use one byte). Total length must be 21.
  if (payload.length !== 21) return null;

  const version = payload[0]!;
  const hash160 = payload.subarray(1);
  const versionBytes = versionBytesForChain(chain.slug);

  if (versionBytes.p2pkh.includes(version)) {
    return { type: "p2pkh", hash160: new Uint8Array(hash160) };
  }
  if (versionBytes.p2sh.includes(version)) {
    return { type: "p2sh", hash160: new Uint8Array(hash160) };
  }
  return null;
}

// scriptPubkey hex for a decoded address. The output script of a tx output
// going to this destination — exactly what bitcoind/electrum reject if it
// doesn't match the canonical form for the address type.
export function scriptPubkeyForDecoded(decoded: DecodedAddress): string {
  switch (decoded.type) {
    case "p2pkh":
      // OP_DUP OP_HASH160 <0x14> <20-byte hash160> OP_EQUALVERIFY OP_CHECKSIG
      return `76a914${bytesToHex(decoded.hash160)}88ac`;
    case "p2sh":
      // OP_HASH160 <0x14> <20-byte hash160> OP_EQUAL
      return `a914${bytesToHex(decoded.hash160)}87`;
    case "p2wpkh":
      // OP_0 <0x14> <20-byte program>
      return `0014${bytesToHex(decoded.program)}`;
    case "p2wsh":
      // OP_0 <0x20> <32-byte program>
      return `0020${bytesToHex(decoded.program)}`;
    case "p2tr":
      // OP_1 <0x20> <32-byte x-only pubkey>
      return `5120${bytesToHex(decoded.program)}`;
  }
}

// Convenience: address string -> scriptPubkey hex for the given chain. Throws
// a stable, operator-readable error on invalid input. Used by payout.service
// to convert merchant destinations and our own change addresses into output
// scripts.
export function destinationScriptPubkey(
  address: string,
  chain: UtxoChainConfig
): string {
  const decoded = decodeUtxoDestination(address, chain);
  if (decoded === null) {
    throw new Error(
      `payout: destination "${address}" is not a valid ${chain.slug} address ` +
        `(supported: P2PKH, P2SH, P2WPKH, P2WSH, P2TR)`
    );
  }
  return scriptPubkeyForDecoded(decoded);
}

// Validate-only check (no scriptPubkey). Used by invoice/payout request
// validation to surface a clean 400 instead of a 500-style throw at
// broadcast time.
export function isValidDestinationAddress(
  address: string,
  chain: UtxoChainConfig
): boolean {
  return decodeUtxoDestination(address, chain) !== null;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}
