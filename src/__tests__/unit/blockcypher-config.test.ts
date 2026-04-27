import { describe, expect, it } from "vitest";
import {
  loadBlockcypherChainConfigs,
  slugToEnvSuffix
} from "../../adapters/detection/blockcypher-config.js";
import type { BlockcypherAdminClient } from "../../adapters/detection/blockcypher-admin-client.js";
import {
  bitcoinChainAdapter,
  litecoinChainAdapter,
  bitcoinTestnetChainAdapter,
  litecoinTestnetChainAdapter
} from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { devChainAdapter } from "../../adapters/chains/dev/dev-chain.adapter.js";
import type { SecretsProvider } from "../../core/ports/secrets.port.js";
import type { Logger } from "../../core/ports/logger.port.js";

// Tests for the env-driven per-chain BlockCypher config loader. Covers:
//   - Slug-to-suffix conversion (bitcoin-testnet → BITCOIN_TESTNET)
//   - Per-chain env discovery across all UTXO chains in deps.chains
//   - Partial config (token without callback or vice versa) throws
//   - Chains BlockCypher can't cover (LTC testnet, blockcypherCoinPath=null)
//     are silently skipped even when env is set
//   - Legacy single-form vars surface as a WARN (not silently applied)

function fakeSecrets(env: Record<string, string>): SecretsProvider {
  return {
    getRequired(key) {
      const v = env[key];
      if (v === undefined || v === "") throw new Error(`missing ${key}`);
      return v;
    },
    getOptional(key) {
      const v = env[key];
      return v === "" || v === undefined ? undefined : v;
    }
  };
}

function bufferingLogger(): Logger & { entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  const log = (level: string) => (msg: string) => {
    entries.push({ level, message: msg });
  };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child() {
      return this;
    },
    entries
  };
}

const FAKE_CLIENT_FACTORY = (token: string): BlockcypherAdminClient => ({
  async subscribe() {
    return {
      id: `hook-${token.slice(0, 4)}`,
      token: "x",
      url: "u",
      address: "a",
      event: "tx-confirmation"
    };
  },
  async unsubscribe() {}
});

describe("slugToEnvSuffix", () => {
  it("uppercases and replaces hyphens with underscores", () => {
    expect(slugToEnvSuffix("bitcoin")).toBe("BITCOIN");
    expect(slugToEnvSuffix("litecoin")).toBe("LITECOIN");
    expect(slugToEnvSuffix("bitcoin-testnet")).toBe("BITCOIN_TESTNET");
    expect(slugToEnvSuffix("litecoin-testnet")).toBe("LITECOIN_TESTNET");
  });
});

describe("loadBlockcypherChainConfigs", () => {
  const allUtxoChains = [
    bitcoinChainAdapter(),
    litecoinChainAdapter(),
    bitcoinTestnetChainAdapter(),
    litecoinTestnetChainAdapter()
  ];

  it("returns empty map when no per-chain envs are set", () => {
    const logger = bufferingLogger();
    const map = loadBlockcypherChainConfigs({
      secrets: fakeSecrets({}),
      chains: allUtxoChains,
      logger,
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(map.size).toBe(0);
  });

  it("populates only the chains whose env pair is set", () => {
    const map = loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN_BITCOIN: "btc-tok",
        BLOCKCYPHER_CALLBACK_URL_BITCOIN: "https://gw/bc/800"
      }),
      chains: allUtxoChains,
      logger: bufferingLogger(),
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(map.size).toBe(1);
    const btc = map.get(800);
    expect(btc?.slug).toBe("bitcoin");
    expect(btc?.token).toBe("btc-tok");
    expect(btc?.callbackUrl).toBe("https://gw/bc/800");
    expect(btc?.coinPath).toBe("btc/main");
    expect(map.has(801)).toBe(false);
  });

  it("populates multiple chains independently", () => {
    const map = loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN_BITCOIN: "btc-tok",
        BLOCKCYPHER_CALLBACK_URL_BITCOIN: "https://gw/bc/800",
        BLOCKCYPHER_TOKEN_LITECOIN: "ltc-tok",
        BLOCKCYPHER_CALLBACK_URL_LITECOIN: "https://gw/bc/801",
        BLOCKCYPHER_TOKEN_BITCOIN_TESTNET: "btc-test-tok",
        BLOCKCYPHER_CALLBACK_URL_BITCOIN_TESTNET: "https://gw/bc/802"
      }),
      chains: allUtxoChains,
      logger: bufferingLogger(),
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(map.size).toBe(3);
    expect(map.get(800)?.token).toBe("btc-tok");
    expect(map.get(801)?.token).toBe("ltc-tok");
    expect(map.get(802)?.token).toBe("btc-test-tok");
    expect(map.get(802)?.coinPath).toBe("btc/test3");
  });

  it("throws on partial config (token without callback URL)", () => {
    expect(() =>
      loadBlockcypherChainConfigs({
        secrets: fakeSecrets({
          BLOCKCYPHER_TOKEN_BITCOIN: "btc-tok"
          // BLOCKCYPHER_CALLBACK_URL_BITCOIN missing
        }),
        chains: allUtxoChains,
        logger: bufferingLogger(),
        clientFactory: FAKE_CLIENT_FACTORY
      })
    ).toThrow(/partial config for chain bitcoin.*BLOCKCYPHER_CALLBACK_URL_BITCOIN/);
  });

  it("throws on partial config (callback URL without token)", () => {
    expect(() =>
      loadBlockcypherChainConfigs({
        secrets: fakeSecrets({
          BLOCKCYPHER_CALLBACK_URL_LITECOIN: "https://gw/bc/801"
          // BLOCKCYPHER_TOKEN_LITECOIN missing
        }),
        chains: allUtxoChains,
        logger: bufferingLogger(),
        clientFactory: FAKE_CLIENT_FACTORY
      })
    ).toThrow(/partial config for chain litecoin.*BLOCKCYPHER_TOKEN_LITECOIN/);
  });

  it("silently skips LTC testnet (BlockCypher doesn't support it) even when env is set", () => {
    // LTC testnet has blockcypherCoinPath=null in utxo-config.ts. Even if
    // an operator sets the env vars (cargo-culting from the BTC pair),
    // the chain is omitted from the map without error.
    const map = loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN_LITECOIN_TESTNET: "ignored",
        BLOCKCYPHER_CALLBACK_URL_LITECOIN_TESTNET: "ignored"
      }),
      chains: allUtxoChains,
      logger: bufferingLogger(),
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(map.has(803)).toBe(false);
  });

  it("ignores non-utxo chains in the chains array", () => {
    // Mixing in EVM/dev chains shouldn't cause confusion. Only utxo-family
    // adapters get scanned.
    const map = loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN_BITCOIN: "btc-tok",
        BLOCKCYPHER_CALLBACK_URL_BITCOIN: "https://gw/bc/800"
      }),
      chains: [devChainAdapter(), bitcoinChainAdapter()],
      logger: bufferingLogger(),
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(map.size).toBe(1);
    expect(map.has(800)).toBe(true);
  });

  it("WARNs when legacy single-form env vars are set", () => {
    // Operators upgrading from the old wiring shouldn't silently lose
    // BlockCypher coverage — surface a WARN pointing at the new var names.
    const logger = bufferingLogger();
    loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN: "old-token",
        BLOCKCYPHER_CALLBACK_URL: "https://old-callback"
      }),
      chains: allUtxoChains,
      logger,
      clientFactory: FAKE_CLIENT_FACTORY
    });
    const warn = logger.entries.find((e) => e.level === "warn");
    expect(warn).toBeDefined();
    expect(warn?.message).toMatch(/legacy env vars/);
    expect(warn?.message).toMatch(/BLOCKCYPHER_TOKEN_<SLUG>/);
  });

  it("doesn't WARN when legacy vars are unset", () => {
    const logger = bufferingLogger();
    loadBlockcypherChainConfigs({
      secrets: fakeSecrets({}),
      chains: allUtxoChains,
      logger,
      clientFactory: FAKE_CLIENT_FACTORY
    });
    expect(logger.entries.find((e) => e.level === "warn")).toBeUndefined();
  });

  it("calls clientFactory once per configured chain (not per row)", () => {
    let factoryCalls = 0;
    loadBlockcypherChainConfigs({
      secrets: fakeSecrets({
        BLOCKCYPHER_TOKEN_BITCOIN: "btc-tok",
        BLOCKCYPHER_CALLBACK_URL_BITCOIN: "https://gw/bc/800",
        BLOCKCYPHER_TOKEN_LITECOIN: "ltc-tok",
        BLOCKCYPHER_CALLBACK_URL_LITECOIN: "https://gw/bc/801"
      }),
      chains: allUtxoChains,
      logger: bufferingLogger(),
      clientFactory: (token) => {
        factoryCalls += 1;
        return FAKE_CLIENT_FACTORY(token);
      }
    });
    expect(factoryCalls).toBe(2);
  });
});
