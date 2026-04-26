import { bech32 } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";

// Native segwit (BIP84) addresses encode a 20-byte HASH160 of the compressed
// secp256k1 public key under witness program version 0. Bech32 (not bech32m;
// bech32m is reserved for v1+ taproot per BIP350).
//
// Encode: hrp + bech32(witness_version || convertbits(20-byte program, 8, 5))
// Decode: parse hrp + version byte + 20-byte program back out.

const WITNESS_VERSION_V0 = 0;
const HASH160_LENGTH_BYTES = 20;

// HASH160 = RIPEMD160(SHA256(x)) — the standard Bitcoin pubkey-hash op.
// Used here for both encode-from-pubkey and matching against scriptPubKey
// digests during signing.
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

// Encode a 20-byte HASH160 (the witness program) as a BIP84 P2WPKH address
// for the given chain HRP ("bc" for Bitcoin, "ltc" for Litecoin).
export function encodeP2wpkhAddress(hrp: string, programHash160: Uint8Array): string {
  if (programHash160.length !== HASH160_LENGTH_BYTES) {
    throw new Error(
      `encodeP2wpkhAddress: expected 20-byte hash160, got ${programHash160.length}`
    );
  }
  // bech32 spec: data = [version, ...convertbits(program, 8, 5)]
  const program5bit = bech32.toWords(programHash160);
  const data = new Uint8Array(1 + program5bit.length);
  data[0] = WITNESS_VERSION_V0;
  data.set(program5bit, 1);
  return bech32.encode(hrp, data);
}

// Decode a P2WPKH bech32 address. Returns null on any malformed input —
// callers (validateAddress, payout destination check) treat null as invalid.
export interface DecodedP2wpkh {
  readonly hrp: string;
  readonly version: number;
  readonly program: Uint8Array;
}

export function decodeP2wpkhAddress(addr: string): DecodedP2wpkh | null {
  let decoded: ReturnType<typeof bech32.decode>;
  try {
    decoded = bech32.decode(addr as `${string}1${string}`);
  } catch {
    return null;
  }
  const { prefix, words } = decoded;
  if (words.length === 0) return null;
  const version = words[0]!;
  // BIP173 + BIP350: version 0 must use bech32 (not bech32m). @scure/base's
  // `bech32.decode` accepts both checksums; we explicitly enforce v0 only
  // here since BIP84 is v0 P2WPKH. v1+ programs (taproot) need bech32m and
  // are out of scope for this v1.
  if (version !== WITNESS_VERSION_V0) return null;
  let program: Uint8Array;
  try {
    program = bech32.fromWords(words.slice(1));
  } catch {
    return null;
  }
  // P2WPKH program is exactly 20 bytes (HASH160). 32-byte programs are
  // P2WSH (script-hash); we don't issue those addresses ourselves but they
  // could legitimately appear as payout destinations — out of scope for v1.
  if (program.length !== HASH160_LENGTH_BYTES) return null;
  return { hrp: prefix, version, program };
}

export function isValidP2wpkhAddress(addr: string, expectedHrp: string): boolean {
  const decoded = decodeP2wpkhAddress(addr);
  if (decoded === null) return false;
  return decoded.hrp === expectedHrp;
}
