import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bip143SighashP2wpkh,
  bytesToHex,
  computeTxid,
  encodeDerSignature,
  hexToBytes,
  serializeSignedTx,
  SIGHASH_ALL,
  type SignedSegwitTx,
  type UnsignedSegwitTx,
  type UtxoInput,
  type UtxoOutput
} from "./utxo-tx-encode.js";
import { hash160 } from "./bech32-address.js";

// Sign and serialize a complete P2WPKH segwit transaction.
//
// Inputs to this function:
//   - The unsigned tx (inputs + outputs + locktime + version)
//   - For each input, the corresponding 32-byte secp256k1 private key
//
// What it does:
//   1. For each input: derive the compressed pubkey, compute the BIP143
//      sighash, sign with deterministic ECDSA (RFC 6979), wrap into DER +
//      append SIGHASH_ALL byte, and emit a 2-item witness stack
//      [signature, pubkey].
//   2. Serialize the signed tx in segwit wire format.
//   3. Return the wire-format hex (for broadcast) plus the txid (for the
//      caller's payouts row).
//
// Determinism: signatures are RFC 6979 + low-s normalization, so the same
// inputs produce the same hex every call. Keeps the gateway's logs and any
// re-broadcast attempts byte-identical.

export interface InputSigningKey {
  // Address whose private key signs THIS input. Used as a sanity check —
  // the caller provides keys keyed by address; we re-derive the pubkey hash
  // and verify it matches the input's prevScriptPubkey before signing, so
  // a wrong-address-key pairing surfaces loudly instead of producing a
  // signature that won't verify on-chain.
  readonly address: string;
  // 32-byte secp256k1 private key, hex (with or without 0x prefix).
  readonly privateKey: string;
}

export interface SignedTxArtifact {
  readonly hex: string;
  readonly txid: string;
  readonly vbytes: number; // approximate vsize for fee accounting
}

export function signSegwitTx(
  tx: UnsignedSegwitTx,
  signingKeys: ReadonlyArray<InputSigningKey>
): SignedTxArtifact {
  if (signingKeys.length !== tx.inputs.length) {
    throw new Error(
      `signSegwitTx: expected ${tx.inputs.length} signing keys (one per input), got ${signingKeys.length}`
    );
  }

  const witnesses: Uint8Array[][] = [];
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i]!;
    const key = signingKeys[i]!;

    // Derive compressed pubkey from the private key.
    const privBytes = privateKeyToBytes(key.privateKey);
    const pubkeyCompressed = secp256k1.getPublicKey(privBytes, true);
    const pubkeyHash = hash160(pubkeyCompressed);

    // Sanity: the input's prevScriptPubkey must be P2WPKH `0014<hash160>`,
    // and the hash MUST match this signing key's pubkey hash. Otherwise
    // we're trying to sign with the wrong key.
    expectMatchingP2wpkh(input.prevScriptPubkey, pubkeyHash, key.address, i);

    // BIP143 sighash for this input.
    const sighash = bip143SighashP2wpkh(tx, i, pubkeyHash);

    // Deterministic ECDSA (RFC 6979). @noble/curves v2 `sign()` returns a
    // 64-byte Uint8Array (r || s, big-endian). Low-s normalization is the
    // @noble default so we don't need to enforce it ourselves.
    const rsRaw = secp256k1.sign(sighash, privBytes);
    const r = rsRaw.slice(0, 32);
    const s = rsRaw.slice(32, 64);

    // DER-wrap and append SIGHASH_ALL = 0x01.
    const der = encodeDerSignature(r, s);
    const sigWithType = new Uint8Array(der.length + 1);
    sigWithType.set(der, 0);
    sigWithType[der.length] = SIGHASH_ALL;

    // P2WPKH witness stack: [signature_with_sighash_type, compressed_pubkey].
    witnesses.push([sigWithType, pubkeyCompressed]);
  }

  const signedTx: SignedSegwitTx = {
    version: tx.version,
    inputs: tx.inputs,
    outputs: tx.outputs,
    witnesses,
    locktime: tx.locktime
  };

  const serialized = serializeSignedTx(signedTx);
  const txid = computeTxid(signedTx);
  const vbytes = approximateVbytes(tx.inputs.length, tx.outputs.length);
  return { hex: bytesToHex(serialized), txid, vbytes };
}

// Strip 0x prefix and decode 32 bytes. Throws if the resulting key isn't
// 32 bytes — protects the secp256k1 lib from silent under-sized input.
function privateKeyToBytes(privateKey: string): Uint8Array {
  const cleaned = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  if (cleaned.length !== 64) {
    throw new Error(
      `signSegwitTx: private key must be 32-byte hex (64 chars), got length ${cleaned.length}`
    );
  }
  return hexToBytes(cleaned);
}

function expectMatchingP2wpkh(
  scriptHex: string,
  expectedHash: Uint8Array,
  signingAddress: string,
  inputIndex: number
): void {
  // P2WPKH scriptPubkey shape: 0x00 (OP_0) 0x14 (push 20 bytes) <20-byte hash>
  if (scriptHex.length !== 44 || !scriptHex.startsWith("0014")) {
    throw new Error(
      `signSegwitTx: input #${inputIndex} prevScriptPubkey is not P2WPKH (got ${scriptHex})`
    );
  }
  const programHex = scriptHex.slice(4);
  const expectedHex = bytesToHex(expectedHash);
  if (programHex.toLowerCase() !== expectedHex) {
    throw new Error(
      `signSegwitTx: input #${inputIndex} signing-key/scriptPubkey mismatch — ` +
        `address ${signingAddress} derives hash160=${expectedHex}, ` +
        `but scriptPubkey carries hash160=${programHex}`
    );
  }
}

// Approximate vsize for a P2WPKH-only tx (all inputs + outputs are P2WPKH).
// Used by fee accounting in callers; not used by the signing logic itself.
//
// Per-component vbyte costs (BIP141 weight / 4):
//   - Tx overhead (version, marker+flag, in_count varint, out_count varint, locktime): ~10.5 vbytes
//   - Per input: 41 base + 27 witness/4 = 41 + ~7 = ~68 vbytes (P2WPKH)
//   - Per output: 31 vbytes (P2WPKH = 8 value + 1 len + 22 script)
function approximateVbytes(inputCount: number, outputCount: number): number {
  return Math.ceil(10.5 + 68 * inputCount + 31 * outputCount);
}

// Re-export so callers can build the unsigned tx without importing two files.
export type { UnsignedSegwitTx, UtxoInput, UtxoOutput };
