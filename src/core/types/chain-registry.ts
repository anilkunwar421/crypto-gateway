import type { ChainFamily, ChainId } from "./chain.js";

// Static registry of every chainId the gateway recognises, mapped to a
// short human-readable slug ("ethereum", "polygon", "tron", etc.) and its
// family. Used by API responses (invoice GET, checkout) to surface a
// stable, UI-friendly chain identifier alongside the numeric chainId.
//
// One source of truth so the slug doesn't drift across surfaces. New chains
// added here automatically show up in any response that calls `chainSlug`.

interface ChainEntry {
  chainId: ChainId;
  slug: string;
  family: ChainFamily;
  displayName: string;
}

export const CHAIN_REGISTRY: readonly ChainEntry[] = [
  // EVM mainnets
  { chainId: 1 as ChainId, slug: "ethereum", family: "evm", displayName: "Ethereum" },
  { chainId: 10 as ChainId, slug: "optimism", family: "evm", displayName: "Optimism" },
  { chainId: 56 as ChainId, slug: "bsc", family: "evm", displayName: "BNB Smart Chain" },
  { chainId: 137 as ChainId, slug: "polygon", family: "evm", displayName: "Polygon" },
  { chainId: 8453 as ChainId, slug: "base", family: "evm", displayName: "Base" },
  { chainId: 42161 as ChainId, slug: "arbitrum", family: "evm", displayName: "Arbitrum One" },
  { chainId: 43114 as ChainId, slug: "avalanche", family: "evm", displayName: "Avalanche C-Chain" },
  // EVM testnets
  { chainId: 11155111 as ChainId, slug: "sepolia", family: "evm", displayName: "Sepolia" },
  // Tron
  { chainId: 728126428 as ChainId, slug: "tron", family: "tron", displayName: "Tron" },
  { chainId: 3448148188 as ChainId, slug: "tron-nile", family: "tron", displayName: "Tron Nile" },
  // Solana (synthetic chainIds — Solana has no EVM-style id)
  { chainId: 900 as ChainId, slug: "solana", family: "solana", displayName: "Solana" },
  { chainId: 901 as ChainId, slug: "solana-devnet", family: "solana", displayName: "Solana Devnet" },
  // UTXO chains (synthetic chainIds — Bitcoin / Litecoin have no EVM-style id).
  // Reserved range 800-899 leaves room for testnets (802=BTC testnet3, 803=LTC
  // testnet) and additional UTXO chains (BCH, DOGE, Zcash transparent) later.
  { chainId: 800 as ChainId, slug: "bitcoin", family: "utxo", displayName: "Bitcoin" },
  { chainId: 801 as ChainId, slug: "litecoin", family: "utxo", displayName: "Litecoin" },
  { chainId: 802 as ChainId, slug: "bitcoin-testnet", family: "utxo", displayName: "Bitcoin Testnet3" },
  { chainId: 803 as ChainId, slug: "litecoin-testnet", family: "utxo", displayName: "Litecoin Testnet" },
  // Monero (synthetic chainIds — Monero has no EVM-style id). Reserved range
  // 1000-1099 leaves room for stagenet/testnet and any future privacy-coin
  // additions in the same family bucket.
  { chainId: 1000 as ChainId, slug: "monero", family: "monero", displayName: "Monero" },
  { chainId: 1001 as ChainId, slug: "monero-stagenet", family: "monero", displayName: "Monero Stagenet" },
  { chainId: 1002 as ChainId, slug: "monero-testnet", family: "monero", displayName: "Monero Testnet" },
  // Dev chain used by integration tests
  { chainId: 999 as ChainId, slug: "dev", family: "evm", displayName: "Dev Chain" }
];

// chainId → slug. Returns null when the id isn't in the registry so callers
// can decide whether to fall back to the numeric id or treat it as an error.
export function chainSlug(chainId: number): string | null {
  const entry = CHAIN_REGISTRY.find((c) => c.chainId === chainId);
  return entry ? entry.slug : null;
}

export function chainEntry(chainId: number): ChainEntry | null {
  return CHAIN_REGISTRY.find((c) => c.chainId === chainId) ?? null;
}
