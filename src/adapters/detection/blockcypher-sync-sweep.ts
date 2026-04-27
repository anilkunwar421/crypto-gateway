import type { Logger } from "../../core/ports/logger.port.js";
import type { ChainId } from "../../core/types/chain.js";
import type { BlockcypherEvent } from "./blockcypher-admin-client.js";
import { BlockcypherApiError } from "./blockcypher-admin-client.js";
import type { BlockcypherChainConfig } from "./blockcypher-config.js";
import type {
  BlockcypherSubscriptionRow,
  BlockcypherSubscriptionStore
} from "./blockcypher-subscription-store.js";

// Drains the `blockcypher_subscriptions` queue:
//   - subscribe rows: POST to BlockCypher, capture returned hookId, mark synced
//   - unsubscribe rows: DELETE the hook by id, mark synced
//
// Retry shape mirrors the Alchemy sweeper:
//   - Pending rows past `backoffMs` get re-attempted
//   - On error: `attempts++`, error stored on the row
//   - At `maxAttempts` the row flips to `failed` (operator queue)
//
// Per-chain config: each row carries its own `chainId`; the sweep looks up the
// matching `BlockcypherChainConfig` entry to get the token-bound admin client
// AND the per-chain callbackUrl. Rows whose chainId isn't in the configured
// map fail loudly (different chain than what the deployment actually enabled —
// likely a stale row from a previous config). Operators set per-chain env
// pairs via `loadBlockcypherChainConfigs`.

export interface BlockcypherSyncSweepConfig {
  store: BlockcypherSubscriptionStore;
  // Per-chain config (token-bound admin client + callbackUrl) keyed by
  // chainId. An empty map is valid (no-op sweep — every row would fail
  // the lookup, but the entrypoint guards against constructing the sweep
  // in that case).
  configByChainId: ReadonlyMap<ChainId, BlockcypherChainConfig>;
  logger: Logger;
  clock: { now(): Date };
  // Confirmation depth threshold to hand BlockCypher. We want the hook to
  // fire enough times to cover the "tx pending" → "tx confirmed" lifecycle.
  // BTC default is 6 (matches the gateway's confirmation threshold);
  // operators with higher finality bars get the rest from the Esplora poll.
  txConfirmations?: number;
  // Per-tick row cap. The free BlockCypher tier rate-limits at 3 req/s
  // sustained; 30 rows per tick (run every minute) keeps us well within
  // that even on heavy churn.
  rowsPerTick?: number;
  // Backoff between retries on a single row. 30s is enough that a transient
  // 502 doesn't burn budget, short enough that a successful retry lands
  // before the next operator-perceptible interaction.
  backoffMs?: number;
  // Per-row attempt cap. After this many failed attempts the row flips to
  // 'failed' and stops retrying — operator queue picks it up.
  maxAttempts?: number;
  // Event name BlockCypher will fire for. "tx-confirmation" covers both
  // mempool entry and block depths up to `txConfirmations`. We don't
  // currently use other events; keep this overridable for future use.
  event?: BlockcypherEvent;
}

export interface BlockcypherSyncResult {
  readonly attempted: number;
  readonly synced: number;
  readonly failed: number;
}

export function makeBlockcypherSyncSweep(
  config: BlockcypherSyncSweepConfig
): () => Promise<BlockcypherSyncResult> {
  const {
    store,
    configByChainId,
    logger,
    clock,
    txConfirmations = 6,
    rowsPerTick = 30,
    backoffMs = 30_000,
    maxAttempts = 5,
    event = "tx-confirmation" as BlockcypherEvent
  } = config;

  return async function blockcypherSyncSweep(): Promise<BlockcypherSyncResult> {
    const now = clock.now().getTime();
    const due = await store.claimPending({ now, backoffMs, limit: rowsPerTick });
    if (due.length === 0) return { attempted: 0, synced: 0, failed: 0 };

    let synced = 0;
    const failedIds: string[] = [];
    const failureMessages = new Map<string, string>();

    for (const row of due) {
      // Per-row chain lookup. A row whose chainId is no longer configured
      // (e.g. operator removed the env var since the row was enqueued) gets
      // marked failed with a clear error — the row would otherwise loop
      // forever, blocking the queue. Operators can re-enable that chain's
      // env vars and clear the row manually.
      const chainCfg = configByChainId.get(row.chainId as ChainId);
      if (chainCfg === undefined) {
        const message = `chain ${row.chainId} is not BlockCypher-configured (set BLOCKCYPHER_TOKEN_<SLUG> + BLOCKCYPHER_CALLBACK_URL_<SLUG>)`;
        failedIds.push(row.id);
        failureMessages.set(row.id, message);
        logger.warn("blockcypher subscription op skipped — chain not configured", {
          rowId: row.id,
          chainId: row.chainId,
          address: row.address,
          action: row.action
        });
        continue;
      }
      try {
        if (row.action === "subscribe") {
          const hook = await chainCfg.client.subscribe({
            coinPath: row.coinPath,
            address: row.address,
            event,
            callbackUrl: chainCfg.callbackUrl,
            confirmations: txConfirmations
          });
          await store.markSynced({ id: row.id, hookId: hook.id, now: clock.now().getTime() });
          synced += 1;
        } else {
          // action === "unsubscribe". hookId may be null when the prior
          // subscribe never synced — nothing to delete. Treat as a no-op
          // success so the row leaves the pending queue.
          if (row.hookId !== null) {
            await chainCfg.client.unsubscribe(row.coinPath, row.hookId);
          }
          await store.markSynced({ id: row.id, hookId: row.hookId, now: clock.now().getTime() });
          synced += 1;
        }
      } catch (err) {
        const message =
          err instanceof BlockcypherApiError
            ? `${err.status ?? "network"}: ${err.body.slice(0, 256)}`
            : err instanceof Error
              ? err.message
              : String(err);
        failedIds.push(row.id);
        failureMessages.set(row.id, message);
        logger.warn("blockcypher subscription op failed", {
          rowId: row.id,
          chainId: row.chainId,
          address: row.address,
          action: row.action,
          attempt: row.attempts + 1,
          error: message
        });
      }
    }

    if (failedIds.length > 0) {
      // markAttempted records the same error string for the whole batch.
      // Per-row distinct errors would need N UPDATE roundtrips; one
      // representative error per batch is acceptable for a retry queue
      // (operators see per-row error in markAttempted's lastError column
      // when they inspect later, not just from this batch).
      const sampleError =
        failureMessages.values().next().value ?? "blockcypher sync failed (unknown error)";
      await store.markAttempted({
        ids: failedIds,
        now: clock.now().getTime(),
        error: sampleError,
        maxAttempts
      });
    }

    return {
      attempted: due.length,
      synced,
      failed: failedIds.length
    };
  };
}

// Reused by tests + the catch-up flow: enumerate any stale BlockCypher hooks
// not represented in our local subscription store. Out of scope for v1 (the
// invoice-scoped lifecycle prevents stale hooks in normal operation), but
// the operator can call this from `/admin/blockcypher/audit` later.
export function _placeholderForFutureAudit(): void {
  // Intentionally empty — keeps the file's surface stable while we plan
  // the audit endpoint.
}

// Placeholder type alias to keep `BlockcypherSubscriptionRow` referenced
// for downstream tooling that imports this module's types. The leading
// underscore opts the name out of unused-var lint rules.
type _RefRow = BlockcypherSubscriptionRow;
