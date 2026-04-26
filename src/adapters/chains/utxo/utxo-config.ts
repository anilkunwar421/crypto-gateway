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
  readonly slug: "bitcoin" | "litecoin";
  readonly coinType: number;
  readonly bech32Hrp: string;
  readonly nativeSymbol: "BTC" | "LTC";
  readonly defaultEsploraUrls: readonly string[];
  // BlockCypher coin slug for /v1/{coin}/{net}/hooks. BTC = "btc/main",
  // LTC = "ltc/main". Used by the push-accelerator subscription path.
  readonly blockcypherCoinPath: string;
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
  blockcypherCoinPath: "btc/main"
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
  blockcypherCoinPath: "ltc/main"
};

export function utxoConfigForChainId(chainId: number): UtxoChainConfig | null {
  if (chainId === BITCOIN_CONFIG.chainId) return BITCOIN_CONFIG;
  if (chainId === LITECOIN_CONFIG.chainId) return LITECOIN_CONFIG;
  return null;
}
