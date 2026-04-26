import { describe, expect, it } from "vitest";
import {
  decodeP2wpkhAddress,
  encodeP2wpkhAddress,
  hash160,
  isValidP2wpkhAddress
} from "../../../../adapters/chains/utxo/bech32-address.js";

// Pin against published P2WPKH (BIP84/BIP173) test vectors. These come from
// the BIP173 reference appendix and BIP84 reference accounts. If a future
// refactor of the underlying @scure/base or @noble/hashes versions changes
// behavior, these break loudly.

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe("hash160", () => {
  // Standard test: HASH160 of empty string = b472a266d0bd89c13706a4132ccfb16f7c3b9fcb
  // (RIPEMD160(SHA256(""))). Catches if either underlying primitive flips.
  it("computes RIPEMD160(SHA256(x)) for the empty input", () => {
    const result = hash160(new Uint8Array(0));
    const expected = "b472a266d0bd89c13706a4132ccfb16f7c3b9fcb";
    expect(Buffer.from(result).toString("hex")).toBe(expected);
  });

  it("matches the reference for a 33-byte compressed pubkey", () => {
    // BIP173 example: pubkey 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    // → HASH160 = 751e76e8199196d454941c45d1b3a323f1433bd6
    const pubkey = hexToBytes(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );
    const result = hash160(pubkey);
    expect(Buffer.from(result).toString("hex")).toBe("751e76e8199196d454941c45d1b3a323f1433bd6");
  });
});

describe("encodeP2wpkhAddress", () => {
  it("encodes a 20-byte program to BIP173 reference vector for Bitcoin", () => {
    // BIP173 reference: program=751e76e8199196d454941c45d1b3a323f1433bd6 + hrp='bc'
    // → bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
    const program = hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6");
    const addr = encodeP2wpkhAddress("bc", program);
    expect(addr).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });

  it("encodes the same program with a different HRP for Litecoin", () => {
    // Same 20-byte program, hrp='ltc' → ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9
    const program = hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6");
    const addr = encodeP2wpkhAddress("ltc", program);
    expect(addr).toBe("ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9");
  });

  it("rejects programs of the wrong length (must be exactly 20 bytes)", () => {
    expect(() => encodeP2wpkhAddress("bc", new Uint8Array(19))).toThrow(/20-byte/);
    expect(() => encodeP2wpkhAddress("bc", new Uint8Array(32))).toThrow(/20-byte/);
  });
});

describe("decodeP2wpkhAddress", () => {
  it("round-trips the BIP173 reference vector", () => {
    const decoded = decodeP2wpkhAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(decoded).not.toBeNull();
    expect(decoded!.hrp).toBe("bc");
    expect(decoded!.version).toBe(0);
    expect(Buffer.from(decoded!.program).toString("hex")).toBe(
      "751e76e8199196d454941c45d1b3a323f1433bd6"
    );
  });

  it("returns null for invalid checksum", () => {
    // Last char flipped — checksum fails.
    expect(decodeP2wpkhAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toBeNull();
  });

  it("returns null for non-zero witness version (taproot uses bech32m, not v0 bech32)", () => {
    // BIP350 P2TR address; v0 decoder must reject — we don't issue these.
    // bc1p... addresses are version 1.
    const result = decodeP2wpkhAddress(
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
    );
    expect(result).toBeNull();
  });

  it("returns null for P2WSH (32-byte program, also v0 bech32) — we only issue P2WPKH", () => {
    // BIP173 reference v0 P2WSH:
    // bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3
    // 32-byte program, valid bech32, but not what we issue.
    const result = decodeP2wpkhAddress(
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"
    );
    expect(result).toBeNull();
  });
});

describe("isValidP2wpkhAddress", () => {
  it("accepts a valid bc1q... address against hrp='bc'", () => {
    expect(isValidP2wpkhAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc")).toBe(true);
  });

  it("rejects a Litecoin address against hrp='bc' (HRP mismatch)", () => {
    expect(isValidP2wpkhAddress("ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9", "bc")).toBe(false);
  });

  it("rejects gibberish", () => {
    expect(isValidP2wpkhAddress("not an address", "bc")).toBe(false);
    expect(isValidP2wpkhAddress("", "bc")).toBe(false);
  });
});
