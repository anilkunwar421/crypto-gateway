import type { ChainAdapter } from "../../core/ports/chain.port.js";
import type { ChainId } from "../../core/types/chain.js";
import type { Logger } from "../../core/ports/logger.port.js";
import type { SecretsProvider } from "../../core/ports/secrets.port.js";
import { utxoConfigForChainId, type UtxoChainConfig } from "../chains/utxo/utxo-config.js";
import {
  blockcypherAdminClient,
  type BlockcypherAdminClient
} from "./blockcypher-admin-client.js";

// Per-chain BlockCypher configuration.
//
// Replaces the old single-form `BLOCKCYPHER_TOKEN` / `BLOCKCYPHER_CALLBACK_URL`
// envs with one pair per UTXO chain, keyed by the chain's `slug` from
// `utxo-config.ts`. Operators set:
//
//   BLOCKCYPHER_TOKEN_BITCOIN              + BLOCKCYPHER_CALLBACK_URL_BITCOIN
//   BLOCKCYPHER_TOKEN_LITECOIN             + BLOCKCYPHER_CALLBACK_URL_LITECOIN
//   BLOCKCYPHER_TOKEN_BITCOIN_TESTNET      + BLOCKCYPHER_CALLBACK_URL_BITCOIN_TESTNET
//   BLOCKCYPHER_TOKEN_LITECOIN_TESTNET     + BLOCKCYPHER_CALLBACK_URL_LITECOIN_TESTNET
//
// Independent BlockCypher accounts (and free-tier hook quotas) per chain;
// per-chain on/off without a code change. Future chains (DASH, DOGE, BCH)
// plug in via the same convention with no entrypoint edits.

export interface BlockcypherChainConfig {
  readonly chainId: ChainId;
  readonly slug: UtxoChainConfig["slug"];
  // BlockCypher coin path (`btc/main`, `ltc/main`, `btc/test3`). Sourced
  // from `utxo-config.ts` and mirrored on each `blockcypher_subscriptions`
  // row at insert time.
  readonly coinPath: string;
  readonly token: string;
  readonly callbackUrl: string;
  // Pre-built admin client bound to this chain's token. The sweep keeps one
  // per chain so it doesn't allocate a fresh client on every row.
  readonly client: BlockcypherAdminClient;
}

// Convert a chain slug (lowercase, may contain hyphens — e.g. "bitcoin",
// "bitcoin-testnet") into the suffix expected on env var names. Hyphens
// become underscores so `bitcoin-testnet` → `BITCOIN_TESTNET`.
export function slugToEnvSuffix(slug: string): string {
  return slug.replace(/-/g, "_").toUpperCase();
}

// Read the env, iterate over registered UTXO chains that BlockCypher supports,
// and build a `Map<chainId, BlockcypherChainConfig>` of fully-configured chains.
//
// Validation rules:
//   - Both `BLOCKCYPHER_TOKEN_<SLUG>` and `BLOCKCYPHER_CALLBACK_URL_<SLUG>` must
//     be set non-empty for a chain to be enabled.
//   - Setting only one of the pair is an explicit configuration error — the
//     deployment is asking for it but won't get it. Throw with a clear message
//     so the operator notices at startup, not silently at first webhook miss.
//   - Chains where BlockCypher doesn't support the coin (e.g. LTC testnet,
//     `blockcypherCoinPath === null` in utxo-config) are skipped silently.
//   - The legacy single-form env vars (`BLOCKCYPHER_TOKEN`, `BLOCKCYPHER_CALLBACK_URL`)
//     are no longer recognized. If set, log a WARN at startup pointing the
//     operator at the new per-chain names.
export interface LoadBlockcypherChainConfigsArgs {
  readonly secrets: SecretsProvider;
  readonly chains: readonly ChainAdapter[];
  readonly logger: Logger;
  // Optional override for tests — supply a fake admin client factory
  // (defaults to the real `blockcypherAdminClient`).
  readonly clientFactory?: (token: string) => BlockcypherAdminClient;
}

export function loadBlockcypherChainConfigs(
  args: LoadBlockcypherChainConfigsArgs
): Map<ChainId, BlockcypherChainConfig> {
  const { secrets, chains, logger } = args;
  const clientFactory =
    args.clientFactory ?? ((token: string) => blockcypherAdminClient({ token }));

  // Surface the legacy-form env vars as a clear WARN so operators upgrading
  // notice. We do NOT silently apply them to all chains — that would be a
  // foot-gun (one chain's leaked token applied everywhere).
  const legacyToken = secrets.getOptional("BLOCKCYPHER_TOKEN");
  const legacyCallback = secrets.getOptional("BLOCKCYPHER_CALLBACK_URL");
  if ((legacyToken ?? "") !== "" || (legacyCallback ?? "") !== "") {
    logger.warn(
      "BlockCypher legacy env vars detected (BLOCKCYPHER_TOKEN / BLOCKCYPHER_CALLBACK_URL). " +
        "These are no longer recognized — set per-chain BLOCKCYPHER_TOKEN_<SLUG> + " +
        "BLOCKCYPHER_CALLBACK_URL_<SLUG> instead (e.g. BLOCKCYPHER_TOKEN_BITCOIN). " +
        "BlockCypher will be disabled until per-chain config is provided.",
      {
        // Don't log the actual token value — secrets discipline.
        legacyTokenSet: (legacyToken ?? "") !== "",
        legacyCallbackSet: (legacyCallback ?? "") !== ""
      }
    );
  }

  const out = new Map<ChainId, BlockcypherChainConfig>();
  // De-dupe by chainId — the chains array could in principle carry duplicates
  // (e.g. tests register a fake adapter alongside the real one).
  const seenChainIds = new Set<number>();
  for (const adapter of chains) {
    if (adapter.family !== "utxo") continue;
    for (const chainId of adapter.supportedChainIds) {
      if (seenChainIds.has(chainId)) continue;
      seenChainIds.add(chainId);
      const utxoCfg = utxoConfigForChainId(chainId);
      if (utxoCfg === null) continue;
      // BlockCypher doesn't support this chain's coin (e.g. LTC testnet) —
      // skip silently; Esplora poll handles detection alone.
      if (utxoCfg.blockcypherCoinPath === null) continue;

      const suffix = slugToEnvSuffix(utxoCfg.slug);
      const tokenName = `BLOCKCYPHER_TOKEN_${suffix}`;
      const callbackName = `BLOCKCYPHER_CALLBACK_URL_${suffix}`;
      const token = secrets.getOptional(tokenName) ?? "";
      const callbackUrl = secrets.getOptional(callbackName) ?? "";

      const tokenSet = token.length > 0;
      const callbackSet = callbackUrl.length > 0;

      // Partial config is a hard error — the operator clearly intended to
      // enable BlockCypher for this chain but only set half the pair.
      // Failing loud at boot beats a silent miss in production.
      if (tokenSet !== callbackSet) {
        throw new Error(
          `BlockCypher partial config for chain ${utxoCfg.slug} (chainId ${chainId}): ` +
            `${tokenSet ? tokenName : callbackName} is set but ${tokenSet ? callbackName : tokenName} is not. ` +
            `Both must be set together to enable BlockCypher push detection for this chain.`
        );
      }
      if (!tokenSet) continue; // chain intentionally disabled

      out.set(chainId, {
        chainId,
        slug: utxoCfg.slug,
        coinPath: utxoCfg.blockcypherCoinPath,
        token,
        callbackUrl,
        client: clientFactory(token)
      });
    }
  }

  return out;
}
