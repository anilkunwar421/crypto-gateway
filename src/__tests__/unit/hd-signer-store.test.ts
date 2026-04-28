import { describe, expect, it } from "vitest";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import {
  bitcoinChainAdapter,
  litecoinChainAdapter,
  bitcoinTestnetChainAdapter
} from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import {
  hdSignerStore,
  NoAdapterForFamilyError,
  UnsupportedSignerOperationError
} from "../../adapters/signer-store/hd.adapter.js";
import type { ChainId } from "../../core/types/chain.js";

const SEED = "test test test test test test test test test test test junk";

describe("hdSignerStore", () => {
  it("derives the same private key as the adapter for pool-address scopes", async () => {
    const adapter = devChainAdapter();
    const store = hdSignerStore({ masterSeed: SEED, chains: [adapter] });

    const derivationIndex = 42;
    const expected = adapter.deriveAddress(SEED, derivationIndex).privateKey;
    const actual = await store.get({ kind: "pool-address", family: "evm", derivationIndex });
    expect(actual).toBe(expected);
  });

  it("pool-address derivation is deterministic across calls", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 7 });
    const b = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 7 });
    expect(a).toBe(b);
  });

  it("different derivationIndex values produce different private keys", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 1 });
    const b = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 2 });
    expect(a).not.toBe(b);
  });

  it("sweep-master key is stable for a family", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const a = await store.get({ kind: "sweep-master", family: "evm" });
    const b = await store.get({ kind: "sweep-master", family: "evm" });
    expect(a).toBe(b);
  });

  it("receive-hd returns the master seed itself", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    const v = await store.get({ kind: "receive-hd" });
    expect(v).toBe(SEED);
  });

  it("put() throws — external-key import is not supported", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.put({ kind: "pool-address", family: "evm", derivationIndex: 0 }, "0xdeadbeef")
    ).rejects.toBeInstanceOf(UnsupportedSignerOperationError);
  });

  it("throws NoAdapterForFamilyError when the family isn't wired", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.get({ kind: "pool-address", family: "tron", derivationIndex: 1 })
    ).rejects.toBeInstanceOf(NoAdapterForFamilyError);
  });

  it("has() reports true for wired families and for receive-hd", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    expect(await store.has({ kind: "receive-hd" })).toBe(true);
    expect(await store.has({ kind: "pool-address", family: "evm", derivationIndex: 0 })).toBe(true);
    expect(await store.has({ kind: "pool-address", family: "tron", derivationIndex: 0 })).toBe(false);
  });

  it("delete() is a no-op (keys aren't stored)", async () => {
    const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
    await expect(
      store.delete({ kind: "pool-address", family: "evm", derivationIndex: 0 })
    ).resolves.toBeUndefined();
    const k = await store.get({ kind: "pool-address", family: "evm", derivationIndex: 0 });
    expect(typeof k).toBe("string");
  });

  // ---- UTXO multi-chain regression ------------------------------------------
  // Pre-fix: when both BTC and LTC adapters were registered, the signer-store
  // index was keyed by `family` only — first-registered won — so EVERY UTXO
  // key resolution went through BTC's adapter (BIP44 coin_type=0). LTC
  // payouts produced a wrong-coin-type key, signSegwitTx caught the
  // hash160 mismatch and surfaced as SOURCE_BROADCAST_FAILED.
  describe("multi-adapter family routing (UTXO chainId disambiguation)", () => {
    it("UTXO scope.chainId routes to the matching chain adapter (LTC vs BTC)", async () => {
      const btc = bitcoinChainAdapter();
      const ltc = litecoinChainAdapter();
      const store = hdSignerStore({ masterSeed: SEED, chains: [btc, ltc] });

      // Truth: each adapter's deriveAddress is the source of truth.
      const btcExpected = btc.deriveAddress(SEED, 5).privateKey;
      const ltcExpected = ltc.deriveAddress(SEED, 5).privateKey;
      expect(btcExpected).not.toBe(ltcExpected); // different coin_type → different keys

      const btcActual = await store.get({
        kind: "pool-address",
        family: "utxo",
        derivationIndex: 5,
        chainId: 800 as ChainId
      });
      const ltcActual = await store.get({
        kind: "pool-address",
        family: "utxo",
        derivationIndex: 5,
        chainId: 801 as ChainId
      });
      expect(btcActual).toBe(btcExpected);
      expect(ltcActual).toBe(ltcExpected);
    });

    it("UTXO testnet adapters resolve independently of mainnet adapters", async () => {
      const btc = bitcoinChainAdapter();
      const btcTestnet = bitcoinTestnetChainAdapter();
      // BTC mainnet uses coin_type=0; testnets share coin_type=1 per slip-0044
      // — so the keys at the same derivationIndex MUST differ.
      const store = hdSignerStore({ masterSeed: SEED, chains: [btc, btcTestnet] });
      const mainnetKey = await store.get({
        kind: "pool-address", family: "utxo", derivationIndex: 0, chainId: 800 as ChainId
      });
      const testnetKey = await store.get({
        kind: "pool-address", family: "utxo", derivationIndex: 0, chainId: 802 as ChainId
      });
      expect(mainnetKey).not.toBe(testnetKey);
      expect(mainnetKey).toBe(btc.deriveAddress(SEED, 0).privateKey);
      expect(testnetKey).toBe(btcTestnet.deriveAddress(SEED, 0).privateKey);
    });

    it("throws when chainId is supplied but not registered", async () => {
      const store = hdSignerStore({ masterSeed: SEED, chains: [bitcoinChainAdapter()] });
      await expect(
        store.get({
          kind: "pool-address",
          family: "utxo",
          derivationIndex: 0,
          chainId: 801 as ChainId // LTC adapter not registered
        })
      ).rejects.toThrow(/no chain adapter registered for chainId=801/);
    });

    it("throws when chainId belongs to a different family than scope.family", async () => {
      const store = hdSignerStore({
        masterSeed: SEED,
        chains: [bitcoinChainAdapter(), devChainAdapter()]
      });
      // chainId 999 is the dev chain (family='evm'), not utxo
      await expect(
        store.get({
          kind: "pool-address",
          family: "utxo",
          derivationIndex: 0,
          chainId: 999 as ChainId
        })
      ).rejects.toThrow(/chainId=999 belongs to family='evm' but scope\.family='utxo'/);
    });

    it("legacy callers (no chainId) still get first-by-family adapter — single-adapter EVM family", async () => {
      // Account-model families register one adapter for the whole family;
      // chainId is irrelevant for derivation. Existing EVM/Tron/Solana
      // callers don't need to pass chainId.
      const store = hdSignerStore({ masterSeed: SEED, chains: [devChainAdapter()] });
      const k = await store.get({
        kind: "pool-address",
        family: "evm",
        derivationIndex: 3
      });
      expect(typeof k).toBe("string");
      expect(k).toBe(devChainAdapter().deriveAddress(SEED, 3).privateKey);
    });
  });
});
