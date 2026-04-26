import { describe, expect, it } from "vitest";
import {
  bitcoinChainAdapter,
  litecoinChainAdapter
} from "../../../../adapters/chains/utxo/utxo-chain.adapter.js";

// BIP84 reference test vectors. The mnemonic + derived addresses are pinned
// by BIP84 itself (https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki).
// External tools (Electrum, Sparrow, ledger-live) all derive the same
// addresses for this seed, so this is the cross-tool sanity check.

const BIP84_TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("BIP84 reference vectors — Bitcoin", () => {
  // From BIP84 spec, mAccountFirstAddress block:
  //   m/84'/0'/0'/0/0 → bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
  //   m/84'/0'/0'/0/1 → bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g
  it.each([
    [0, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"],
    [1, "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"]
  ])("derives address index %i to %s", (index, expectedAddress) => {
    const adapter = bitcoinChainAdapter();
    const { address } = adapter.deriveAddress(BIP84_TEST_MNEMONIC, index);
    expect(address).toBe(expectedAddress);
  });

  it("addressFromPrivateKey reproduces the same address as deriveAddress", () => {
    const adapter = bitcoinChainAdapter();
    const { address, privateKey } = adapter.deriveAddress(BIP84_TEST_MNEMONIC, 0);
    expect(adapter.addressFromPrivateKey(privateKey)).toBe(address);
  });

  it("derivation is deterministic — same seed + index always yields the same pair", () => {
    const adapter = bitcoinChainAdapter();
    const a = adapter.deriveAddress(BIP84_TEST_MNEMONIC, 5);
    const b = adapter.deriveAddress(BIP84_TEST_MNEMONIC, 5);
    expect(a.address).toBe(b.address);
    expect(a.privateKey).toBe(b.privateKey);
  });
});

describe("BIP84 — Litecoin (slip-0044 coin_type 2)", () => {
  // No widely-published canonical Litecoin BIP84 vectors exist for this
  // mnemonic, so the contract test is internal: the same seed must produce
  // bech32 addresses with hrp='ltc' and identical structure (HASH160 of
  // compressed pubkey at m/84'/2'/0'/0/N). External tools that follow
  // SLIP-0044 (Trezor Suite, Ledger Live for LTC) will produce the same
  // addresses.
  it("derives at m/84'/2'/0'/0/0 to a valid ltc1q... bech32 P2WPKH address", () => {
    const adapter = litecoinChainAdapter();
    const { address } = adapter.deriveAddress(BIP84_TEST_MNEMONIC, 0);
    expect(address).toMatch(/^ltc1q[023456789acdefghjklmnpqrstuvwxyz]{38,}$/);
    expect(adapter.validateAddress(address)).toBe(true);
  });

  it("Litecoin and Bitcoin derive DIFFERENT addresses for the same index (different coin_type)", () => {
    const btc = bitcoinChainAdapter();
    const ltc = litecoinChainAdapter();
    const btcAddr = btc.deriveAddress(BIP84_TEST_MNEMONIC, 0).address;
    const ltcAddr = ltc.deriveAddress(BIP84_TEST_MNEMONIC, 0).address;
    expect(btcAddr).not.toBe(ltcAddr);
    expect(btcAddr.startsWith("bc1q")).toBe(true);
    expect(ltcAddr.startsWith("ltc1q")).toBe(true);
  });
});

describe("validateAddress / canonicalizeAddress", () => {
  it("accepts a self-derived bc1q address and rejects the LTC version on the BTC adapter", () => {
    const btc = bitcoinChainAdapter();
    const { address: btcAddress } = btc.deriveAddress(BIP84_TEST_MNEMONIC, 0);
    const { address: ltcAddress } = litecoinChainAdapter().deriveAddress(BIP84_TEST_MNEMONIC, 0);

    expect(btc.validateAddress(btcAddress)).toBe(true);
    expect(btc.validateAddress(ltcAddress)).toBe(false); // wrong HRP for BTC adapter
  });

  it("canonicalizes mixed-case input by lowercasing", () => {
    const adapter = bitcoinChainAdapter();
    const { address } = adapter.deriveAddress(BIP84_TEST_MNEMONIC, 0);
    // Mixed-case is invalid per BIP173 (must be all-upper or all-lower) —
    // but lowercase is canonical, so an all-uppercase variant of a valid
    // address must canonicalize to the lowercase form.
    const upper = address.toUpperCase();
    expect(adapter.canonicalizeAddress(upper)).toBe(address);
  });

  it("rejects clearly invalid input", () => {
    const adapter = bitcoinChainAdapter();
    expect(() => adapter.canonicalizeAddress("not an address")).toThrow();
    expect(() => adapter.canonicalizeAddress("0x0000000000000000000000000000000000000000")).toThrow();
  });
});

describe("nativeSymbol + minimumNativeReserve + feeWalletCapability", () => {
  it("Bitcoin adapter reports BTC, 0n reserve, no fee-wallet capability", () => {
    const adapter = bitcoinChainAdapter();
    expect(adapter.nativeSymbol(800 as never)).toBe("BTC");
    expect(adapter.minimumNativeReserve(800 as never)).toBe(0n);
    expect(adapter.feeWalletCapability(800 as never)).toBe("none");
  });

  it("Litecoin adapter reports LTC", () => {
    const adapter = litecoinChainAdapter();
    expect(adapter.nativeSymbol(801 as never)).toBe("LTC");
  });

  it("supportedChainIds = [chainId] for the configured chain only", () => {
    expect(bitcoinChainAdapter().supportedChainIds).toEqual([800]);
    expect(litecoinChainAdapter().supportedChainIds).toEqual([801]);
  });
});
