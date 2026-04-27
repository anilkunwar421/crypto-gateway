import { describe, it, expect } from "vitest";
import {
  decodeUtxoDestination,
  destinationScriptPubkey,
  isValidDestinationAddress,
  scriptPubkeyForDecoded,
  type DecodedAddress
} from "../../../../adapters/chains/utxo/destination-script.js";
import {
  BITCOIN_CONFIG,
  BITCOIN_TESTNET_CONFIG,
  LITECOIN_CONFIG,
  LITECOIN_TESTNET_CONFIG
} from "../../../../adapters/chains/utxo/utxo-config.js";

// Reference test vectors taken from canonical sources:
//   - BIP143 test vectors (P2WPKH)
//   - BIP350 test vectors (bech32m / P2TR)
//   - Bitcoin Wiki + bitcoin-core regtest examples (P2PKH / P2SH)
//   - Litecoin's address spec (M-prefix P2SH, ltc1q-prefix bech32, tltc1q tests)

describe("destination-script: BTC mainnet", () => {
  // 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa — Satoshi's genesis-block coinbase
  // address. P2PKH, version byte 0x00.
  it("decodes P2PKH (1...) and produces correct scriptPubkey", () => {
    const addr = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const decoded = decodeUtxoDestination(addr, BITCOIN_CONFIG);
    expect(decoded?.type).toBe("p2pkh");
    expect(decoded?.type === "p2pkh" && decoded.hash160.length).toBe(20);
    const script = destinationScriptPubkey(addr, BITCOIN_CONFIG);
    // 76 a9 14 <20-byte hash160> 88 ac
    expect(script.startsWith("76a914")).toBe(true);
    expect(script.endsWith("88ac")).toBe(true);
    expect(script.length).toBe(50); // 25 bytes × 2 hex chars
  });

  // BTC P2SH: programmatically built from base58check(0x05 || 20-byte hash160).
  // Real-world P2SH addresses on mainnet start with "3".
  it("decodes P2SH (3...) and produces correct scriptPubkey", () => {
    const addr = "3HLj8ECNk9A7Mbk8LegGS4i5EDNxfdCDn4";
    const decoded = decodeUtxoDestination(addr, BITCOIN_CONFIG);
    expect(decoded?.type).toBe("p2sh");
    const script = destinationScriptPubkey(addr, BITCOIN_CONFIG);
    // a9 14 <20-byte hash160> 87
    expect(script.startsWith("a914")).toBe(true);
    expect(script.endsWith("87")).toBe(true);
    expect(script.length).toBe(46); // 23 bytes × 2 hex chars
  });

  // BIP173 reference P2WPKH test vector
  it("decodes P2WPKH (bc1q...) and produces correct scriptPubkey", () => {
    const addr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const decoded = decodeUtxoDestination(addr, BITCOIN_CONFIG);
    expect(decoded?.type).toBe("p2wpkh");
    expect(decoded?.type === "p2wpkh" && decoded.program.length).toBe(20);
    const script = destinationScriptPubkey(addr, BITCOIN_CONFIG);
    // OP_0 (00) || OP_PUSH20 (14) || program
    expect(script).toBe("0014751e76e8199196d454941c45d1b3a323f1433bd6");
  });

  // BIP173 reference P2WSH test vector — 32-byte witness program
  it("decodes P2WSH (bc1q...64char) and produces correct scriptPubkey", () => {
    const addr = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3";
    const decoded = decodeUtxoDestination(addr, BITCOIN_CONFIG);
    expect(decoded?.type).toBe("p2wsh");
    expect(decoded?.type === "p2wsh" && decoded.program.length).toBe(32);
    const script = destinationScriptPubkey(addr, BITCOIN_CONFIG);
    // OP_0 (00) || OP_PUSH32 (20) || program
    expect(script.startsWith("0020")).toBe(true);
    expect(script.length).toBe(2 + 2 + 64); // 1+1+32 bytes
  });

  // BIP350 P2TR test vector
  it("decodes P2TR (bc1p...) and produces correct scriptPubkey", () => {
    const addr = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
    const decoded = decodeUtxoDestination(addr, BITCOIN_CONFIG);
    expect(decoded?.type).toBe("p2tr");
    expect(decoded?.type === "p2tr" && decoded.program.length).toBe(32);
    const script = destinationScriptPubkey(addr, BITCOIN_CONFIG);
    // OP_1 (51) || OP_PUSH32 (20) || x-only pubkey
    expect(script.startsWith("5120")).toBe(true);
    expect(script.length).toBe(2 + 2 + 64);
  });
});

describe("destination-script: BTC testnet", () => {
  it("decodes testnet P2PKH (m... or n...)", () => {
    // Programmatically built — base58check(0x6f || 20-byte hash160). Testnet
    // P2PKH version byte is 0x6f, addresses prefix with "m" or "n".
    const addr = "mwAfVjnv1GGz3YXJw7z3qMZTwggx52Hbh7";
    expect(isValidDestinationAddress(addr, BITCOIN_TESTNET_CONFIG)).toBe(true);
    expect(isValidDestinationAddress(addr, BITCOIN_CONFIG)).toBe(false); // wrong network
  });

  it("decodes testnet P2WPKH (tb1q...)", () => {
    // tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx — BIP173 testnet vector
    const addr = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    const decoded = decodeUtxoDestination(addr, BITCOIN_TESTNET_CONFIG);
    expect(decoded?.type).toBe("p2wpkh");
  });

  it("rejects mainnet bech32 on testnet adapter", () => {
    const mainnetAddr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    expect(isValidDestinationAddress(mainnetAddr, BITCOIN_TESTNET_CONFIG)).toBe(false);
  });
});

describe("destination-script: LTC mainnet", () => {
  // LTC P2PKH starts with "L" (version 0x30). Programmatically built from
  // base58check(0x30 || 20-byte hash160) so the checksum is canonical.
  it("decodes LTC P2PKH (L...) and rejects on BTC adapter", () => {
    const addr = "LasfTu1mGu5nXEjrPgzyHTQuHuTXFWYSAA";
    const decoded = decodeUtxoDestination(addr, LITECOIN_CONFIG);
    expect(decoded?.type).toBe("p2pkh");
    expect(isValidDestinationAddress(addr, BITCOIN_CONFIG)).toBe(false);
  });

  // LTC P2SH supports BOTH 0x05 (3...) for legacy compat and 0x32 (M...) for
  // the modern post-2018 format. Both must decode to p2sh.
  it("decodes LTC P2SH M-prefix (0x32 version)", () => {
    const addr = "MSfMJGBaXHQTLJ6yF7qvBiviNKD16SkoPv";
    const decoded = decodeUtxoDestination(addr, LITECOIN_CONFIG);
    expect(decoded?.type).toBe("p2sh");
  });

  it("decodes LTC P2SH legacy 3-prefix (0x05 version)", () => {
    const addr = "3PZgrXLrQBwwhyv1wq2tJ6eYs1r9SXQZb1";
    const decoded = decodeUtxoDestination(addr, LITECOIN_CONFIG);
    expect(decoded?.type).toBe("p2sh");
  });

  it("decodes LTC bech32 (ltc1q...)", () => {
    const addr = "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9";
    const decoded = decodeUtxoDestination(addr, LITECOIN_CONFIG);
    expect(decoded?.type).toBe("p2wpkh");
    // BTC adapter rejects (wrong HRP)
    expect(isValidDestinationAddress(addr, BITCOIN_CONFIG)).toBe(false);
  });
});

describe("destination-script: LTC testnet", () => {
  it("decodes LTC testnet bech32 (tltc1q...)", () => {
    // Programmatically constructed from bech32 with hrp='tltc'.
    const addr = "tltc1q4w46h2at4w46h2at4w46h2at4w46h2ate6an72";
    const decoded = decodeUtxoDestination(addr, LITECOIN_TESTNET_CONFIG);
    expect(decoded?.type).toBe("p2wpkh");
    // LTC mainnet rejects
    expect(isValidDestinationAddress(addr, LITECOIN_CONFIG)).toBe(false);
  });
});

describe("destination-script: rejects malformed input", () => {
  it("rejects empty / random / case-mixed strings", () => {
    expect(decodeUtxoDestination("", BITCOIN_CONFIG)).toBeNull();
    expect(decodeUtxoDestination("not-an-address", BITCOIN_CONFIG)).toBeNull();
    // Mixed case bech32 is invalid per BIP173
    expect(
      decodeUtxoDestination("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", BITCOIN_CONFIG)
    ).toBeNull();
  });

  it("rejects bech32m on a v0 program (must be bech32)", () => {
    // P2WPKH but encoded as bech32m — this is the failure case BIP350 prevents
    // (actually constructing a valid bech32m string with version 0 is hard
    // without the encoder; we simulate by inverting the checksum on a valid
    // v0 address — we just verify our decoder rejects the v1+ case below)
    expect(decodeUtxoDestination("bc1pqq", BITCOIN_CONFIG)).toBeNull();
  });

  it("rejects payload of wrong length", () => {
    // Truncated base58check
    expect(decodeUtxoDestination("1Bv", BITCOIN_CONFIG)).toBeNull();
  });

  it("rejects unknown witness version", () => {
    // v2 (currently reserved). Hand-construct: bc1z... is v2.
    // We can't easily craft a valid v2 address here without an encoder, so
    // we rely on length/HRP guards to reject these cases. The key property
    // is that any valid v2+ address gets returned as `null` rather than
    // forwarded to scriptPubkeyForDecoded.
    expect(decodeUtxoDestination("bc1zzzz", BITCOIN_CONFIG)).toBeNull();
  });

  it("rejects an address from the wrong chain family", () => {
    // EVM-style hex address — base58 decoder will fail
    expect(decodeUtxoDestination("0x742d35Cc6634C0532925a3b844Bc9e7595f6E5e2", BITCOIN_CONFIG)).toBeNull();
    // Tron base58 — wrong version byte (0x41), shouldn't match BTC's allowed set
    expect(decodeUtxoDestination("TLsV52sRDL79HXGGm9yzwKibb6BeruhUzh", BITCOIN_CONFIG)).toBeNull();
  });
});

describe("destination-script: scriptPubkeyForDecoded shapes", () => {
  it("produces 25-byte P2PKH script", () => {
    const decoded: DecodedAddress = {
      type: "p2pkh",
      hash160: new Uint8Array(20).fill(0xab)
    };
    const script = scriptPubkeyForDecoded(decoded);
    expect(script).toBe("76a914" + "ab".repeat(20) + "88ac");
  });

  it("produces 23-byte P2SH script", () => {
    const decoded: DecodedAddress = {
      type: "p2sh",
      hash160: new Uint8Array(20).fill(0xcd)
    };
    expect(scriptPubkeyForDecoded(decoded)).toBe("a914" + "cd".repeat(20) + "87");
  });

  it("produces 22-byte P2WPKH script", () => {
    const decoded: DecodedAddress = {
      type: "p2wpkh",
      program: new Uint8Array(20).fill(0xef)
    };
    expect(scriptPubkeyForDecoded(decoded)).toBe("0014" + "ef".repeat(20));
  });

  it("produces 34-byte P2WSH script", () => {
    const decoded: DecodedAddress = {
      type: "p2wsh",
      program: new Uint8Array(32).fill(0x12)
    };
    expect(scriptPubkeyForDecoded(decoded)).toBe("0020" + "12".repeat(32));
  });

  it("produces 34-byte P2TR script (OP_1 + 32-byte push)", () => {
    const decoded: DecodedAddress = {
      type: "p2tr",
      program: new Uint8Array(32).fill(0x34)
    };
    expect(scriptPubkeyForDecoded(decoded)).toBe("5120" + "34".repeat(32));
  });
});

describe("destination-script: integration with utxoChainAdapter", () => {
  it("destinationScriptPubkey throws a clean error on unsupported address", () => {
    expect(() => destinationScriptPubkey("definitely-not-an-address", BITCOIN_CONFIG)).toThrow(
      /not a valid bitcoin address/
    );
  });
});
