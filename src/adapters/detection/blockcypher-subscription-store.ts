import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { blockcypherSubscriptions } from "../../db/schema.js";

// BlockCypher push-detection subscription queue. Each row is one
// pending/synced/failed `subscribe` or `unsubscribe` operation against the
// `/v1/{coin}/{net}/hooks` endpoint. The tracker enqueues on invoice
// lifecycle events; the sweeper claims + resolves with retry backoff.
//
// Mirrors `alchemy-subscription-store` in shape — different action enum
// (`subscribe`/`unsubscribe` vs `add`/`remove`), additional `coinPath` and
// `hookId` fields specific to BlockCypher's URL routing + hook-id model.

export type BlockcypherAction = "subscribe" | "unsubscribe";
export type BlockcypherSubStatus = "pending" | "synced" | "failed";

export interface BlockcypherSubscriptionRow {
  id: string;
  chainId: number;
  coinPath: string;
  address: string;
  action: BlockcypherAction;
  hookId: string | null;
  status: BlockcypherSubStatus;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BlockcypherInsertPendingArgs {
  chainId: number;
  coinPath: string;
  address: string;
  action: BlockcypherAction;
  // Pre-populated for `unsubscribe` rows (the prior subscribe's hookId);
  // null for `subscribe` rows (BlockCypher returns the id at sync time).
  hookId: string | null;
  now: number;
}

export interface BlockcypherSubscriptionStore {
  insertPending(args: BlockcypherInsertPendingArgs): Promise<string>;
  claimPending(args: {
    now: number;
    backoffMs: number;
    limit: number;
  }): Promise<readonly BlockcypherSubscriptionRow[]>;
  markSynced(args: { id: string; hookId: string | null; now: number }): Promise<void>;
  markAttempted(args: {
    ids: readonly string[];
    now: number;
    error: string;
    maxAttempts: number;
  }): Promise<void>;
  // Lookup the hookId for the most-recent successful subscribe to (chainId,
  // address). Used by the tracker when enqueuing an unsubscribe — without
  // the hookId we can't DELETE.
  findActiveHookId(chainId: number, address: string): Promise<string | null>;
  countByStatus(): Promise<Record<BlockcypherSubStatus, number>>;
}

function drizzleRowToBlockcypherSubscription(
  row: typeof blockcypherSubscriptions.$inferSelect
): BlockcypherSubscriptionRow {
  return {
    id: row.id,
    chainId: row.chainId,
    coinPath: row.coinPath,
    address: row.address,
    action: row.action,
    hookId: row.hookId,
    status: row.status,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt === null ? null : new Date(row.lastAttemptAt),
    lastError: row.lastError,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

export function dbBlockcypherSubscriptionStore(db: Db): BlockcypherSubscriptionStore {
  return {
    async insertPending({ chainId, coinPath, address, action, hookId, now }) {
      const id = globalThis.crypto.randomUUID();
      await db.insert(blockcypherSubscriptions).values({
        id,
        chainId,
        coinPath,
        address,
        action,
        hookId,
        status: "pending",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      });
      return id;
    },

    async claimPending({ now, backoffMs, limit }) {
      const threshold = now - backoffMs;
      const rows = await db
        .select()
        .from(blockcypherSubscriptions)
        .where(
          and(
            eq(blockcypherSubscriptions.status, "pending"),
            or(
              isNull(blockcypherSubscriptions.lastAttemptAt),
              lte(blockcypherSubscriptions.lastAttemptAt, threshold)
            )
          )
        )
        .orderBy(
          asc(blockcypherSubscriptions.chainId),
          asc(blockcypherSubscriptions.createdAt)
        )
        .limit(limit);
      return rows.map(drizzleRowToBlockcypherSubscription);
    },

    async markSynced({ id, hookId, now }) {
      // For subscribe ops we capture the hookId BlockCypher returned. For
      // unsubscribe ops the hookId is fixed; pass through whatever the row
      // already had.
      await db
        .update(blockcypherSubscriptions)
        .set({
          status: "synced",
          hookId,
          lastError: null,
          updatedAt: now
        })
        .where(eq(blockcypherSubscriptions.id, id));
    },

    async markAttempted({ ids, now, error, maxAttempts }) {
      if (ids.length === 0) return;
      await db
        .update(blockcypherSubscriptions)
        .set({
          attempts: sql`${blockcypherSubscriptions.attempts} + 1`,
          lastAttemptAt: now,
          lastError: error.slice(0, 2048),
          updatedAt: now,
          status: sql`CASE WHEN ${blockcypherSubscriptions.attempts} + 1 >= ${maxAttempts} THEN 'failed' ELSE ${blockcypherSubscriptions.status} END`
        })
        .where(inArray(blockcypherSubscriptions.id, ids as string[]));
    },

    async findActiveHookId(chainId, address) {
      // The most recent `subscribe` row in 'synced' state for this address
      // carries the hookId we'd want to unsubscribe later. We search by
      // (chainId, address, action='subscribe', status='synced') ordered
      // by createdAt DESC so a re-subscribe (after a prior unsubscribe)
      // returns the FRESH hookId, not the stale one.
      const [row] = await db
        .select({ hookId: blockcypherSubscriptions.hookId })
        .from(blockcypherSubscriptions)
        .where(
          and(
            eq(blockcypherSubscriptions.chainId, chainId),
            eq(blockcypherSubscriptions.address, address),
            eq(blockcypherSubscriptions.action, "subscribe"),
            eq(blockcypherSubscriptions.status, "synced")
          )
        )
        .orderBy(sql`${blockcypherSubscriptions.createdAt} DESC`)
        .limit(1);
      return row?.hookId ?? null;
    },

    async countByStatus() {
      const rows = await db
        .select({
          status: blockcypherSubscriptions.status,
          n: sql<number>`COUNT(*)`
        })
        .from(blockcypherSubscriptions)
        .groupBy(blockcypherSubscriptions.status);
      const out: Record<BlockcypherSubStatus, number> = {
        pending: 0,
        synced: 0,
        failed: 0
      };
      for (const row of rows) {
        if (row.status === "pending" || row.status === "synced" || row.status === "failed") {
          out[row.status] = Number(row.n);
        }
      }
      return out;
    }
  };
}
