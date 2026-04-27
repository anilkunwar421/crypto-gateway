import { describe, expect, it, vi } from "vitest";
import { makeBlockcypherSyncSweep } from "../../adapters/detection/blockcypher-sync-sweep.js";
import {
  BlockcypherApiError,
  type BlockcypherAdminClient
} from "../../adapters/detection/blockcypher-admin-client.js";
import type { BlockcypherChainConfig } from "../../adapters/detection/blockcypher-config.js";
import type {
  BlockcypherSubscriptionRow,
  BlockcypherSubscriptionStore
} from "../../adapters/detection/blockcypher-subscription-store.js";
import type { ChainId } from "../../core/types/chain.js";

// Build a single-chain config map (covers chainId 800 / BTC mainnet by default)
// pointing the per-chain client + callbackUrl at the supplied test fakes.
function chainConfigMap(
  client: BlockcypherAdminClient,
  callbackUrl = "https://gw/cb",
  chainId: ChainId = 800 as ChainId,
  slug: BlockcypherChainConfig["slug"] = "bitcoin",
  coinPath = "btc/main"
): ReadonlyMap<ChainId, BlockcypherChainConfig> {
  return new Map<ChainId, BlockcypherChainConfig>([
    [chainId, { chainId, slug, coinPath, token: "test-token", callbackUrl, client }]
  ]);
}

// In-memory fakes — same pattern as the alchemy-sync-sweep tests. We don't
// hit the network or DB; the sweeper is pure orchestration over the two
// dependencies, so a small in-memory model nails behavior without any
// integration overhead.

function fakeStore(rows: BlockcypherSubscriptionRow[]): BlockcypherSubscriptionStore & {
  syncedIds: string[];
  attempts: Array<{ ids: readonly string[]; error: string }>;
} {
  const syncedIds: string[] = [];
  const attempts: Array<{ ids: readonly string[]; error: string }> = [];
  return {
    async insertPending() {
      throw new Error("not used by sweep");
    },
    async claimPending() {
      // Return any rows still in `pending` status. Tests pre-seed the rows
      // and the sweeper processes them in order.
      return rows.filter((r) => r.status === "pending");
    },
    async markSynced({ id, hookId }) {
      syncedIds.push(id);
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = "synced";
        row.hookId = hookId;
      }
    },
    async markAttempted({ ids, error, maxAttempts }) {
      attempts.push({ ids, error });
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (row) {
          row.attempts += 1;
          row.lastError = error;
          if (row.attempts >= maxAttempts) row.status = "failed";
        }
      }
    },
    async findActiveHookId() {
      return null;
    },
    async countByStatus() {
      const out = { pending: 0, synced: 0, failed: 0 };
      for (const r of rows) out[r.status] += 1;
      return out;
    },
    syncedIds,
    attempts
  };
}

function fakeAdminClient(impl: Partial<BlockcypherAdminClient>): BlockcypherAdminClient {
  return {
    async subscribe() {
      throw new Error("subscribe not stubbed");
    },
    async unsubscribe() {
      throw new Error("unsubscribe not stubbed");
    },
    ...impl
  };
}

const NOOP_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return NOOP_LOGGER;
  }
};

const FIXED_NOW = 1_700_000_000_000;

function row(over: Partial<BlockcypherSubscriptionRow>): BlockcypherSubscriptionRow {
  return {
    id: "row1",
    chainId: 800,
    coinPath: "btc/main",
    address: "bc1qaddr",
    action: "subscribe",
    hookId: null,
    status: "pending",
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    createdAt: new Date(FIXED_NOW),
    updatedAt: new Date(FIXED_NOW),
    ...over
  };
}

describe("blockcypherSyncSweep", () => {
  it("subscribe row: calls client.subscribe, captures hookId, marks synced", async () => {
    const rows = [row({ id: "r1", action: "subscribe" })];
    const store = fakeStore(rows);
    const subscribe = vi.fn(async () => ({
      id: "hook-abc-123",
      token: "tok",
      url: "https://gw/cb",
      address: "bc1qaddr",
      event: "tx-confirmation"
    }));
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(
        fakeAdminClient({ subscribe }),
        "https://gw/webhooks/blockcypher/800"
      ),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(subscribe).toHaveBeenCalledWith({
      coinPath: "btc/main",
      address: "bc1qaddr",
      event: "tx-confirmation",
      callbackUrl: "https://gw/webhooks/blockcypher/800",
      confirmations: 6
    });
    expect(store.syncedIds).toEqual(["r1"]);
    expect(rows[0]?.hookId).toBe("hook-abc-123");
  });

  it("unsubscribe row: calls client.unsubscribe with the prior hookId, marks synced", async () => {
    const rows = [row({ id: "r2", action: "unsubscribe", hookId: "hook-xyz" })];
    const store = fakeStore(rows);
    const unsubscribe = vi.fn(async () => undefined);
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({ unsubscribe })),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(unsubscribe).toHaveBeenCalledWith("btc/main", "hook-xyz");
  });

  it("unsubscribe row with hookId=null is a no-op success (no DELETE call)", async () => {
    // Happens when the prior subscribe never synced — there's no hook to
    // delete, but the row should leave 'pending' so it doesn't retry forever.
    const rows = [row({ id: "r3", action: "unsubscribe", hookId: null })];
    const store = fakeStore(rows);
    const unsubscribe = vi.fn();
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({ unsubscribe })),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result.synced).toBe(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("on subscribe error: bumps attempts, retries on next tick (status stays pending)", async () => {
    const rows = [row({ id: "r4", action: "subscribe" })];
    const store = fakeStore(rows);
    const subscribe = vi.fn(async () => {
      throw new BlockcypherApiError(503, "service unavailable", "/v1/btc/main/hooks");
    });
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({ subscribe })),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) },
      maxAttempts: 5
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 1, synced: 0, failed: 1 });
    expect(rows[0]?.status).toBe("pending"); // not yet at maxAttempts
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain("503");
  });

  it("flips to failed at maxAttempts (retries don't exceed cap)", async () => {
    const rows = [row({ id: "r5", action: "subscribe", attempts: 4 })];
    const store = fakeStore(rows);
    const subscribe = vi.fn(async () => {
      throw new BlockcypherApiError(500, "internal error", "/v1/btc/main/hooks");
    });
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({ subscribe })),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) },
      maxAttempts: 5
    });
    await sweep();
    expect(rows[0]?.status).toBe("failed"); // attempts 4 + 1 == 5 = maxAttempts
  });

  it("no-ops cleanly when no rows are pending", async () => {
    const store = fakeStore([]);
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({})),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 0, synced: 0, failed: 0 });
  });

  it("processes multiple rows in one tick", async () => {
    const rows = [
      row({ id: "r6", action: "subscribe", address: "bc1q1" }),
      row({ id: "r7", action: "subscribe", address: "bc1q2" }),
      row({ id: "r8", action: "unsubscribe", hookId: "hook-1", address: "bc1q3" })
    ];
    const store = fakeStore(rows);
    let subId = 0;
    const subscribe = vi.fn(async ({ address }) => ({
      id: `hook-${++subId}`,
      token: "tok",
      url: "u",
      address,
      event: "tx-confirmation"
    }));
    const unsubscribe = vi.fn(async () => undefined);
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({ subscribe, unsubscribe })),
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 3, synced: 3, failed: 0 });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("routes per-chain: rows for chain 800 use BTC client/callback; rows for chain 801 use LTC client/callback", async () => {
    // Two chains configured. Each must use ITS OWN client + callbackUrl.
    // The previous bug-shape (single global token) would have routed every
    // row through the same client; this test catches that regression.
    const rows = [
      row({ id: "btc-row", action: "subscribe", chainId: 800, coinPath: "btc/main", address: "bc1qaddr" }),
      row({ id: "ltc-row", action: "subscribe", chainId: 801, coinPath: "ltc/main", address: "ltc1qaddr" })
    ];
    const store = fakeStore(rows);
    const btcSubscribe = vi.fn(async () => ({ id: "h-btc", token: "t", url: "u", address: "bc1qaddr", event: "tx-confirmation" }));
    const ltcSubscribe = vi.fn(async () => ({ id: "h-ltc", token: "t", url: "u", address: "ltc1qaddr", event: "tx-confirmation" }));
    const btcClient = fakeAdminClient({ subscribe: btcSubscribe });
    const ltcClient = fakeAdminClient({ subscribe: ltcSubscribe });
    const configByChainId = new Map<ChainId, BlockcypherChainConfig>([
      [800 as ChainId, { chainId: 800 as ChainId, slug: "bitcoin", coinPath: "btc/main", token: "btc-tok", callbackUrl: "https://gw/btc-cb", client: btcClient }],
      [801 as ChainId, { chainId: 801 as ChainId, slug: "litecoin", coinPath: "ltc/main", token: "ltc-tok", callbackUrl: "https://gw/ltc-cb", client: ltcClient }]
    ]);
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId,
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) }
    });
    const result = await sweep();
    expect(result).toEqual({ attempted: 2, synced: 2, failed: 0 });
    expect(btcSubscribe).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: "https://gw/btc-cb" }));
    expect(ltcSubscribe).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: "https://gw/ltc-cb" }));
    expect(btcSubscribe).toHaveBeenCalledTimes(1);
    expect(ltcSubscribe).toHaveBeenCalledTimes(1);
  });

  it("rows for chains NOT in configByChainId are marked failed with a clear error", async () => {
    // Operator removed the env vars for chain 801 but a stale row is still
    // in the queue. The sweep should fail it (not loop forever) so the
    // operator notices the issue.
    const rows = [
      row({ id: "stale-ltc", action: "subscribe", chainId: 801, coinPath: "ltc/main", address: "ltc1qaddr" })
    ];
    const store = fakeStore(rows);
    const sweep = makeBlockcypherSyncSweep({
      store,
      configByChainId: chainConfigMap(fakeAdminClient({})), // only chain 800 configured
      logger: NOOP_LOGGER,
      clock: { now: () => new Date(FIXED_NOW) },
      maxAttempts: 1
    });
    const result = await sweep();
    expect(result.failed).toBe(1);
    expect(rows[0]?.lastError).toContain("not BlockCypher-configured");
    // After 1 attempt with maxAttempts=1, row flips to failed.
    expect(rows[0]?.status).toBe("failed");
  });
});
