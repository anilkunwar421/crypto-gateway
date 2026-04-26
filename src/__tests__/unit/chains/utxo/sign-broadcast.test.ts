import { describe, expect, it } from "vitest";
import {
  bitcoinChainAdapter,
  buildUtxoUnsignedTx,
  utxoChainAdapter
} from "../../../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../../../adapters/chains/utxo/utxo-config.js";
import type { EsploraClient } from "../../../../adapters/chains/utxo/esplora-rpc.js";
import {
  encodeP2wpkhAddress,
  hash160
} from "../../../../adapters/chains/utxo/bech32-address.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "../../../../adapters/chains/utxo/utxo-tx-encode.js";
import { signSegwitTx } from "../../../../adapters/chains/utxo/utxo-sign.js";
import type { UnsignedSegwitTx } from "../../../../adapters/chains/utxo/utxo-tx-encode.js";

// End-to-end coverage of the adapter's payout-side methods:
//   1. signAndBroadcast: signs, calls Esplora.broadcastTx, verifies remote
//      txid matches local, returns the txid
//   2. quoteFeeTiers projects Esplora /fee-estimates into low/medium/high
//   3. getBalance / getAccountBalances reflect Esplora chain_stats
//   4. buildTransfer throws (UTXO doesn't fit the account-model signature)

function fakeClient(impl: Partial<EsploraClient>): EsploraClient {
  return {
    async getAddressTxs() { return []; },
    async getAddressMempoolTxs() { return []; },
    async getTx() { throw new Error("getTx not used"); },
    async getTipHeight() { return 0; },
    async broadcastTx() { throw new Error("broadcastTx not stubbed"); },
    async getFeeEstimates() { return {}; },
    async getAddressBalanceSats() { return 0n; },
    ...impl
  };
}

function deriveTestKeypair(privHex: string): {
  privateKey: string;
  pubkeyCompressed: Uint8Array;
  address: string;
} {
  const priv = hexToBytes(privHex);
  const pubkeyCompressed = secp256k1.getPublicKey(priv, true);
  const address = encodeP2wpkhAddress("bc", hash160(pubkeyCompressed));
  return { privateKey: privHex, pubkeyCompressed, address };
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

describe("utxoChainAdapter — payout-side methods", () => {
  it("signAndBroadcast: signs each input, broadcasts hex, returns the verified txid", async () => {
    const kp = deriveTestKeypair("a".repeat(64));

    // Pre-compute what the deterministic signing pipeline will produce.
    // We assemble the same UnsignedSegwitTx the adapter does, sign it,
    // then have the fake `broadcastTx` echo back the resulting txid.
    const inputs = [
      {
        prevTxid: "11".repeat(32),
        prevVout: 0,
        prevScriptPubkey: "0014" + bytesToHex(hash160(kp.pubkeyCompressed)),
        prevValue: 100_000n,
        sequence: 0xfffffffd
      }
    ];
    const outputs = [{ scriptPubkey: "0014" + "22".repeat(20), value: 90_000n }];
    const expectedTx: UnsignedSegwitTx = { version: 2, locktime: 0, inputs, outputs };
    const expected = signSegwitTx(expectedTx, [{ address: kp.address, privateKey: kp.privateKey }]);

    let capturedHex = "";
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async broadcastTx(hex) {
          capturedHex = hex;
          return expected.txid;
        }
      })
    });

    const unsigned = buildUtxoUnsignedTx(
      800 as never,
      [
        {
          txid: "11".repeat(32),
          vout: 0,
          value: 100_000n,
          scriptPubkey: "0014" + bytesToHex(hash160(kp.pubkeyCompressed)),
          address: kp.address
        }
      ],
      [{ scriptPubkey: "0014" + "22".repeat(20), value: 90_000n }]
    );

    const txid = await adapter.signAndBroadcast(unsigned, "", {
      inputPrivateKeys: [{ address: kp.address as never, privateKey: kp.privateKey }]
    });

    expect(txid).toBe(expected.txid);
    expect(capturedHex).toBe(expected.hex);
  });

  it("signAndBroadcast: throws when remote txid doesn't match local-computed txid", async () => {
    const kp = deriveTestKeypair("b".repeat(64));
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async broadcastTx() {
          // Server returns a wrong txid — adapter must surface the divergence.
          return "00".repeat(32);
        }
      })
    });
    const unsigned = buildUtxoUnsignedTx(
      800 as never,
      [
        {
          txid: "11".repeat(32),
          vout: 0,
          value: 100_000n,
          scriptPubkey: "0014" + bytesToHex(hash160(kp.pubkeyCompressed)),
          address: kp.address
        }
      ],
      [{ scriptPubkey: "0014" + "22".repeat(20), value: 90_000n }]
    );
    await expect(
      adapter.signAndBroadcast(unsigned, "", {
        inputPrivateKeys: [{ address: kp.address as never, privateKey: kp.privateKey }]
      })
    ).rejects.toThrow(/remote txid.*!=.*local txid/);
  });

  it("signAndBroadcast: throws when inputPrivateKeys count mismatches input count", async () => {
    const kp = deriveTestKeypair("c".repeat(64));
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fakeClient({}) });
    const unsigned = buildUtxoUnsignedTx(
      800 as never,
      [
        { txid: "11".repeat(32), vout: 0, value: 100_000n, scriptPubkey: "0014" + bytesToHex(hash160(kp.pubkeyCompressed)), address: kp.address },
        { txid: "22".repeat(32), vout: 1, value: 50_000n, scriptPubkey: "0014" + bytesToHex(hash160(kp.pubkeyCompressed)), address: kp.address }
      ],
      [{ scriptPubkey: "0014" + "33".repeat(20), value: 130_000n }]
    );
    await expect(
      adapter.signAndBroadcast(unsigned, "", {
        inputPrivateKeys: [{ address: kp.address as never, privateKey: kp.privateKey }]
      })
    ).rejects.toThrow(/one key per input/);
  });

  it("signAndBroadcast: rejects an unsignedTx whose raw isn't a UTXO build", async () => {
    const adapter = bitcoinChainAdapter();
    await expect(
      adapter.signAndBroadcast({ chainId: 800 as never, raw: { family: "evm", to: "0x..." } }, "", {
        inputPrivateKeys: []
      })
    ).rejects.toThrow(/not a UTXO build/);
  });

  it("buildTransfer throws — UTXO uses the buildUtxoUnsignedTx path instead", async () => {
    const adapter = bitcoinChainAdapter();
    await expect(
      adapter.buildTransfer({
        chainId: 800 as never,
        fromAddress: "bc1qany" as never,
        toAddress: "bc1qany" as never,
        token: "BTC" as never,
        amountRaw: "1000" as never
      })
    ).rejects.toThrow(/account-model only/);
  });

  it("quoteFeeTiers: projects Esplora /fee-estimates onto low/medium/high tiers", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getFeeEstimates() {
          return { "1": 50, "2": 40, "3": 30, "6": 15, "10": 10, "144": 5 };
        }
      })
    });
    const tiers = await adapter.quoteFeeTiers({
      chainId: 800 as never,
      fromAddress: "bc1qa" as never,
      toAddress: "bc1qb" as never,
      token: "BTC" as never,
      amountRaw: "10000" as never
    });
    expect(tiers.tieringSupported).toBe(true);
    expect(tiers.nativeSymbol).toBe("BTC");
    const VBYTES = 141;
    expect(tiers.high.nativeAmountRaw).toBe((VBYTES * 50).toString());
    expect(tiers.medium.nativeAmountRaw).toBe((VBYTES * 30).toString());
    expect(tiers.low.nativeAmountRaw).toBe((VBYTES * 15).toString());
  });

  it("quoteFeeTiers: falls back to 1 sat/vB minimum when Esplora returns empty estimates", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({ async getFeeEstimates() { return {}; } })
    });
    const tiers = await adapter.quoteFeeTiers({
      chainId: 800 as never,
      fromAddress: "bc1qa" as never,
      toAddress: "bc1qb" as never,
      token: "BTC" as never,
      amountRaw: "10000" as never
    });
    expect(tiers.medium.nativeAmountRaw).toBe("141"); // 141 vbytes × 1 sat/vB
  });

  it("getBalance returns Esplora's confirmed balance for the native token", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressBalanceSats(addr) {
          return addr === "bc1qhello" ? 50_000n : 0n;
        }
      })
    });
    const bal = await adapter.getBalance({
      chainId: 800 as never,
      address: "bc1qhello" as never,
      token: "BTC" as never
    });
    expect(bal).toBe("50000");
  });

  it("getBalance returns 0 for non-native tokens (UTXO chains have only native)", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressBalanceSats() {
          throw new Error("must not query Esplora for non-native tokens");
        }
      })
    });
    const bal = await adapter.getBalance({
      chainId: 800 as never,
      address: "bc1q" as never,
      token: "USDC" as never
    });
    expect(bal).toBe("0");
  });

  it("getAccountBalances returns one entry for the native token", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({
        async getAddressBalanceSats() {
          return 1_234_567n;
        }
      })
    });
    const balances = await adapter.getAccountBalances({
      chainId: 800 as never,
      address: "bc1qany" as never
    });
    expect(balances).toHaveLength(1);
    expect(balances[0]).toEqual({ token: "BTC", amountRaw: "1234567" });
  });

  it("getAccountBalances returns empty when balance is 0 (avoids zero-row noise)", async () => {
    const adapter = utxoChainAdapter({
      chain: BITCOIN_CONFIG,
      esplora: fakeClient({ async getAddressBalanceSats() { return 0n; } })
    });
    const balances = await adapter.getAccountBalances({
      chainId: 800 as never,
      address: "bc1qany" as never
    });
    expect(balances).toHaveLength(0);
  });
});
