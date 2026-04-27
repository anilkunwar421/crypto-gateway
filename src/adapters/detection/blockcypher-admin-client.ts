// Thin client for BlockCypher's `/v1/{coin}/{net}/hooks` endpoint. We only
// implement the two operations the gateway needs:
//   POST   /v1/{coin}/{net}/hooks?token=KEY   (subscribe an address)
//   DELETE /v1/{coin}/{net}/hooks/{id}?token=KEY  (unsubscribe)
//
// Webhook delivery is push-based: BlockCypher POSTs to `webhookCallbackUrl`
// when a tx touching the address hits the mempool / confirms. The gateway's
// HTTP route at `/webhooks/blockcypher` parses the payload and feeds it to
// the existing `ingestDetectedTransfer` pipeline.
//
// Reference: https://www.blockcypher.com/dev/bitcoin/#events-and-hooks

export type BlockcypherEvent =
  | "unconfirmed-tx"
  | "confirmed-tx"
  | "tx-confirmation"
  | "new-block";

export interface BlockcypherSubscribeArgs {
  // BlockCypher's coin + net path: "btc/main" or "ltc/main".
  readonly coinPath: string;
  // Watched address — bech32 P2WPKH for our use case.
  readonly address: string;
  // Event subtype. We use "tx-confirmation" because it fires both on
  // mempool entry (`confirmations: 0`) and on each block depth up to a
  // configurable threshold (default 6) — covers our entire detection
  // lifecycle in one subscription.
  readonly event: BlockcypherEvent;
  // URL BlockCypher will POST to. Must be reachable from the public
  // internet. The gateway hosts `/webhooks/blockcypher` for this purpose.
  readonly callbackUrl: string;
  // Confirmations to fire `tx-confirmation` for. 6 covers our default
  // BTC threshold; merchants with higher thresholds get caught by the
  // Esplora poll backstop.
  readonly confirmations?: number;
}

export interface BlockcypherCreatedHook {
  readonly id: string;
  readonly token: string;
  readonly url: string;
  readonly callback_errors?: number;
  readonly address: string;
  readonly event: string;
}

export interface BlockcypherAdminClient {
  subscribe(args: BlockcypherSubscribeArgs): Promise<BlockcypherCreatedHook>;
  unsubscribe(coinPath: string, hookId: string): Promise<void>;
}

export interface BlockcypherAdminClientConfig {
  // BlockCypher API token. Free tier gives 200 active hooks; paid tiers
  // raise the cap. Operators set via `BLOCKCYPHER_TOKEN` env.
  readonly token: string;
  // Override base URL (tests inject a fake server). Defaults to
  // BlockCypher's production endpoint.
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export class BlockcypherApiError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly body: string,
    public readonly path: string
  ) {
    super(`blockcypher API ${path} failed (status=${status ?? "network"}): ${body}`);
    this.name = "BlockcypherApiError";
  }
}

export function blockcypherAdminClient(
  config: BlockcypherAdminClientConfig
): BlockcypherAdminClient {
  const baseUrl = (config.baseUrl ?? "https://api.blockcypher.com").replace(/\/+$/, "");
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const token = config.token;

  return {
    async subscribe({ coinPath, address, event, callbackUrl, confirmations }) {
      const path = `/v1/${coinPath}/hooks?token=${encodeURIComponent(token)}`;
      const body = {
        event,
        address,
        url: callbackUrl,
        ...(event === "tx-confirmation" && confirmations !== undefined
          ? { confirmations }
          : {})
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new BlockcypherApiError(res.status, errBody, path);
        }
        return (await res.json()) as BlockcypherCreatedHook;
      } catch (err) {
        if (err instanceof BlockcypherApiError) throw err;
        throw new BlockcypherApiError(null, String(err), path);
      } finally {
        clearTimeout(timer);
      }
    },

    async unsubscribe(coinPath, hookId) {
      // BlockCypher returns 204 No Content on successful DELETE. A 404
      // means the hook was already gone (operator deleted manually, or a
      // prior unsubscribe attempt actually succeeded but our local row
      // didn't get marked synced) — treat as success so the sweeper
      // doesn't keep retrying a dead hook.
      const path = `/v1/${coinPath}/hooks/${hookId}?token=${encodeURIComponent(token)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: "DELETE",
          signal: controller.signal
        });
        if (res.status === 204 || res.status === 200 || res.status === 404) {
          return;
        }
        const errBody = await res.text().catch(() => "");
        throw new BlockcypherApiError(res.status, errBody, path);
      } catch (err) {
        if (err instanceof BlockcypherApiError) throw err;
        throw new BlockcypherApiError(null, String(err), path);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
