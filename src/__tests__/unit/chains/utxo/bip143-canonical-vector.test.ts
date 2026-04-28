import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bip143SighashP2wpkh,
  bytesToHex,
  concatBytes,
  encodeLeUint32,
  encodeLeUint64,
  encodeVarint,
  hash256,
  hexToBytes,
  type UnsignedSegwitTx
} from "../../../../adapters/chains/utxo/utxo-tx-encode.js";

// BIP143 canonical native-P2WPKH test vector. Source:
//   https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki

function reverseHex(hex: string): string {
  const fwd = hexToBytes(hex);
  const out = new Uint8Array(fwd.length);
  for (let i = 0; i < fwd.length; i += 1) out[i] = fwd[fwd.length - 1 - i]!;
  return bytesToHex(out);
}

describe("BIP143 canonical native-P2WPKH sighash vector", () => {
  // Fixture (display-order prevTxids, what Esplora returns + what we store):
  const inputs = [
    {
      // Wire (per spec): fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f
      // Display (reversed): 9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff
      prevTxid: "9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff",
      prevVout: 0,
      prevScriptPubkey: "0014" + "00".repeat(20),
      prevValue: 625_000_000n,
      // Spec wire bytes: ee ff ff ff (LE) → 0xffffffee
      sequence: 0xffffffee
    },
    {
      prevTxid: "8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef",
      prevVout: 1,
      prevScriptPubkey: "00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1",
      prevValue: 600_000_000n,
      sequence: 0xffffffff
    }
  ];
  const outputs = [
    { scriptPubkey: "76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac", value: 112_340_000n },
    { scriptPubkey: "76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac", value: 223_450_000n }
  ];
  const tx: UnsignedSegwitTx = { version: 1, locktime: 0x11, inputs, outputs };

  it("hashPrevouts matches the spec", () => {
    // Spec: dSHA256(reverse(txid1) || vout1 LE || reverse(txid2) || vout2 LE)
    const concat = concatBytes(
      ...inputs.map((i) =>
        concatBytes(hexToBytes(reverseHex(i.prevTxid)), encodeLeUint32(i.prevVout))
      )
    );
    const h = hash256(concat);
    expect(bytesToHex(h)).toBe(
      "96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37"
    );
  });

  it("hashSequence matches the spec", () => {
    const concat = concatBytes(...inputs.map((i) => encodeLeUint32(i.sequence)));
    const h = hash256(concat);
    expect(bytesToHex(h)).toBe(
      "52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b"
    );
  });

  it("hashOutputs matches the spec", () => {
    const concat = concatBytes(
      ...outputs.map((o) => {
        const script = hexToBytes(o.scriptPubkey);
        return concatBytes(encodeLeUint64(o.value), encodeVarint(script.length), script);
      })
    );
    const h = hash256(concat);
    expect(bytesToHex(h)).toBe(
      "863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5"
    );
  });

  it("matches the spec's published sighash for input #2", () => {
    const pubkeyHash = hexToBytes("1d0f172a0ecb48aee1be1f2687d2963ae33f71a1");
    const sighash = bip143SighashP2wpkh(tx, 1, pubkeyHash);
    expect(bytesToHex(sighash)).toBe(
      "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
    );
  });

  it("RFC6979 deterministic ECDSA produces the spec's r for input #2 (low-S normalized)", async () => {
    // Spec privkey for native P2WPKH input #2.
    //   privKey:   619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9
    //
    // BIP143 (2016) was written before BIP146 (2017) made low-S consensus.
    // The spec's published `s` (41b16f7c…) is the high-S form. Modern
    // Bitcoin Core rejects high-S sigs (NULLFAIL); @noble/curves with
    // lowS:true normalizes to the low-S equivalent (same sig math, valid
    // under both old and new policy). r is unaffected by low-S, so we
    // compare it directly against the spec.
    //
    // CRITICAL: pass `{ prehash: false }` because `sighash` is already the
    // 32-byte BIP143 digest. The default `prehash: true` would silently
    // SHA256 it AGAIN, producing a signature that's mathematically valid
    // for SHA256(sighash) but rejected on-chain. This is the exact bug
    // that caused live LTC payouts to fail with `non-mandatory-script-
    // verify-flag (Signature must be zero for failed CHECK(MULTI)SIG
    // operation)` — see utxo-sign.ts.
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const priv = hexToBytes("619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9");
    const pubkeyHash = hexToBytes("1d0f172a0ecb48aee1be1f2687d2963ae33f71a1");
    const sighash = bip143SighashP2wpkh(tx, 1, pubkeyHash);
    const rs = secp256k1.sign(sighash, priv, { prehash: false, lowS: true });
    const r = bytesToHex(rs.slice(0, 32));
    expect(r).toBe("3609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a");

    // Self-consistency: noble's verify against our sighash + the derived
    // pubkey accepts the signature. If this passes but the chain rejects,
    // the bug is in the sighash computation, not the signing.
    const pubkey = secp256k1.getPublicKey(priv, true);
    expect(secp256k1.verify(rs, sighash, pubkey, { prehash: false, lowS: true })).toBe(true);
  });

  // Stop unused-imports complaints if a future test rewrites these blocks.
  void sha256;
});
