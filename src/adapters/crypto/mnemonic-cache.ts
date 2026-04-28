import { mnemonicToSeedSync } from "@scure/bip39";

// Per-process cache for `mnemonicToSeedSync` — pure function of the
// mnemonic, but each call runs PBKDF2 with 2048 SHA-512 rounds (BIP39
// spec) which costs ~100–300 ms on most hardware. Without caching, every
// fresh-derivation hot path (UTXO invoice creation, every signing call
// across UTXO/Tron/Solana) pays that cost.
//
// Caching by the mnemonic STRING (not by a hash) is fine here: the
// process already holds the mnemonic in memory via deps.secrets, and the
// cached 64-byte seed is no more sensitive than the mnemonic itself.
// Worker isolates / Node processes have their own memory; the cache
// lives until process restart.
//
// Typical cache size: 1 entry (the deployment's MASTER_SEED). The Map
// is keyed by mnemonic so multi-tenant deployments that swap seeds at
// runtime still get correct derivation — just without the speedup
// across switches.

const cache = new Map<string, Uint8Array>();

export function cachedMnemonicToSeed(mnemonic: string): Uint8Array {
  let seed = cache.get(mnemonic);
  if (seed === undefined) {
    seed = mnemonicToSeedSync(mnemonic);
    cache.set(mnemonic, seed);
  }
  return seed;
}
