import type { ChainId } from "../../../core/types/chain.js";

// Per-chain UTXO configuration. The chain adapter is parameterized by these
// constants — single ChainAdapter implementation, two registered chains.
//
// `coinType` is the BIP44 coin_type (slip-0044). `bech32Hrp` is the
// human-readable prefix on segwit addresses. `nativeSymbol` matches the
// token-registry entry. `defaultEsploraUrls` are the public Esplora
// endpoints we'll round-robin / failover across in detection.
export interface UtxoChainConfig {
  readonly chainId: ChainId;
  readonly slug: "bitcoin" | "litecoin" | "bitcoin-testnet" | "litecoin-testnet";
  // BIP44 coin_type per slip-0044. Mainnet uses 0 (BTC) / 2 (LTC); testnets
  // share coin_type 1 ("All test-nets"), so a single MASTER_SEED produces
  // the same testnet addresses across BTC testnet3 and LTC testnet (they
  // can't collide on-chain because chains are independent).
  readonly coinType: number;
  readonly bech32Hrp: string;
  readonly nativeSymbol: "BTC" | "LTC";
  readonly defaultEsploraUrls: readonly string[];
  // BlockCypher coin slug for /v1/{coin}/{net}/hooks. BTC mainnet = "btc/main",
  // BTC testnet3 = "btc/test3", LTC mainnet = "ltc/main", LTC testnet =
  // not supported by BlockCypher (operators relying on testnet LTC fall
  // back to Esplora poll only).
  readonly blockcypherCoinPath: string | null;
  // When true, this chain is a testnet — used by callers that want to
  // suppress side-effects (BlockCypher, alerting) for non-production chains.
  readonly testnet: boolean;
}

export const BITCOIN_CONFIG: UtxoChainConfig = {
  chainId: 800 as ChainId,
  slug: "bitcoin",
  coinType: 0,
  bech32Hrp: "bc",
  nativeSymbol: "BTC",
  defaultEsploraUrls: [
    "https://mempool.space/api",
    "https://blockstream.info/api"
  ],
  blockcypherCoinPath: "btc/main",
  testnet: false
};

export const LITECOIN_CONFIG: UtxoChainConfig = {
  chainId: 801 as ChainId,
  slug: "litecoin",
  coinType: 2,
  bech32Hrp: "ltc",
  nativeSymbol: "LTC",
  defaultEsploraUrls: [
    "https://litecoinspace.org/api"
  ],
  blockcypherCoinPath: "ltc/main",
  testnet: false
};

// Bitcoin testnet3 (chainId 802). HRP "tb" per BIP173. coin_type 1 per
// slip-0044 ("All test-nets share coin_type 1"). Esplora endpoints:
// mempool.space/testnet and blockstream.info/testnet. BlockCypher's path
// is "btc/test3" (their Wallet API names testnet3 explicitly because BCY
// also has a "bcy/test" sandbox chain that's separate).
export const BITCOIN_TESTNET_CONFIG: UtxoChainConfig = {
  chainId: 802 as ChainId,
  slug: "bitcoin-testnet",
  coinType: 1,
  bech32Hrp: "tb",
  nativeSymbol: "BTC",
  defaultEsploraUrls: [
    "https://mempool.space/testnet/api",
    "https://blockstream.info/testnet/api"
  ],
  blockcypherCoinPath: "btc/test3",
  testnet: true
};

// Litecoin testnet (chainId 803). HRP "tltc" per the litecoin-project
// BIP173 reference. coin_type 1 (shared testnet). Esplora coverage is
// thinner — litecoinspace.org doesn't host testnet — so we fall back to
// blockstream-style endpoints if/when operators self-host. BlockCypher
// doesn't have an LTC testnet endpoint, so push detection is unavailable
// here (`blockcypherCoinPath: null` → tracker skips enqueue).
export const LITECOIN_TESTNET_CONFIG: UtxoChainConfig = {
  chainId: 803 as ChainId,
  slug: "litecoin-testnet",
  coinType: 1,
  bech32Hrp: "tltc",
  nativeSymbol: "LTC",
  defaultEsploraUrls: [
    // No widely-available public Esplora testnet for LTC. Operators who
    // need LTC testnet host their own Electrs/Esplora and override this
    // via the chain adapter's `esploraBackends` config.
    "https://litecoin-testnet.example/api"
  ],
  blockcypherCoinPath: null,
  testnet: true
};

export function utxoConfigForChainId(chainId: number): UtxoChainConfig | null {
  switch (chainId) {
    case BITCOIN_CONFIG.chainId: return BITCOIN_CONFIG;
    case LITECOIN_CONFIG.chainId: return LITECOIN_CONFIG;
    case BITCOIN_TESTNET_CONFIG.chainId: return BITCOIN_TESTNET_CONFIG;
    case LITECOIN_TESTNET_CONFIG.chainId: return LITECOIN_TESTNET_CONFIG;
    default: return null;
  }
}
