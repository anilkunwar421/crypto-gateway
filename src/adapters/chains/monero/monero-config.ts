import type { ChainId } from "../../../core/types/chain.js";
import type { MoneroNetwork } from "./monero-crypto.js";
import {
  DEFAULT_MAINNET_BACKENDS,
  DEFAULT_STAGENET_BACKENDS,
  DEFAULT_TESTNET_BACKENDS
} from "./monero-rpc.js";

// Per-chain Monero configuration. A single ChainAdapter (in
// monero-chain.adapter.ts) is parameterized by one of these so the same
// crypto + RPC code serves mainnet, stagenet, and testnet.
//
// `nativeSymbol` is always "XMR". `network` selects the base58 prefix byte
// the adapter accepts in `validateAddress` / emits in `deriveAddress`.

export interface MoneroChainConfig {
  readonly chainId: ChainId;
  readonly slug: "monero" | "monero-stagenet" | "monero-testnet";
  readonly network: MoneroNetwork;
  readonly defaultRpcUrls: readonly string[];
  readonly testnet: boolean;
}

export const MONERO_MAINNET_CONFIG: MoneroChainConfig = {
  chainId: 1000 as ChainId,
  slug: "monero",
  network: "mainnet",
  defaultRpcUrls: DEFAULT_MAINNET_BACKENDS,
  testnet: false
};

export const MONERO_STAGENET_CONFIG: MoneroChainConfig = {
  chainId: 1001 as ChainId,
  slug: "monero-stagenet",
  network: "stagenet",
  defaultRpcUrls: DEFAULT_STAGENET_BACKENDS,
  testnet: true
};

export const MONERO_TESTNET_CONFIG: MoneroChainConfig = {
  chainId: 1002 as ChainId,
  slug: "monero-testnet",
  network: "testnet",
  defaultRpcUrls: DEFAULT_TESTNET_BACKENDS,
  testnet: true
};

export function moneroConfigForChainId(chainId: number): MoneroChainConfig | null {
  switch (chainId) {
    case MONERO_MAINNET_CONFIG.chainId: return MONERO_MAINNET_CONFIG;
    case MONERO_STAGENET_CONFIG.chainId: return MONERO_STAGENET_CONFIG;
    case MONERO_TESTNET_CONFIG.chainId: return MONERO_TESTNET_CONFIG;
    default: return null;
  }
}
