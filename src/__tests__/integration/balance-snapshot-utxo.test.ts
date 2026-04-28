import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import type {
  EsploraClient
} from "../../adapters/chains/utxo/esplora-rpc.js";
import { computeBalanceSnapshot } from "../../core/domain/balance-snapshot.service.js";
import { payouts, transactions, utxos } from "../../db/schema.js";
import type { ChainId } from "../../core/types/chain.js";
import { bootTestApp } from "../helpers/boot.js";

// UTXO addresses live in `invoice_receive_addresses` (not `address_pool`),
// so the balance snapshot has to enumerate them via the `utxos` spendability
// table. This test inserts a confirmed UTXO and asserts:
//   1. db-mode surfaces the utxo family + the chain's native BTC balance
//   2. spending the UTXO (spent_in_payout_id != NULL) hides it again
//   3. unconfirmed parent transactions don't count
// Without the fix, all three checks would emit zero utxo rows.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;

// Minimal stub — the snapshot db-mode path doesn't call Esplora at all,
// so we can give the adapter a placeholder client.
function noopEsplora(): EsploraClient {
  const fail = () => {
    throw new Error("Esplora not used in db-mode balance snapshot test");
  };
  return {
    getAddressTxs: fail,
    getAddressMempoolTxs: fail,
    getTx: fail,
    getTipHeight: fail,
    broadcastTx: fail,
    getFeeEstimates: fail,
    getAddressBalanceSats: fail
  };
}

describe("balance-snapshot — utxo (db mode)", () => {
  it("surfaces UTXO family balances by reading the spendability table directly", async () => {
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: noopEsplora() });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const invRes = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
        })
      );
      expect(invRes.status).toBe(201);
      const invoice = (
        (await invRes.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }
      ).invoice;

      // Insert a confirmed transaction + matching utxos row paying the invoice.
      const now = booted.deps.clock.now().getTime();
      const txId = "tx-utxo-1";
      await booted.deps.db.insert(transactions).values({
        id: txId,
        invoiceId: invoice.id,
        chainId: BTC_CHAIN_ID,
        txHash: "ab".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        toAddress: invoice.receiveAddress,
        token: "BTC",
        amountRaw: "150000",
        blockNumber: 100,
        confirmations: 12,
        status: "confirmed",
        detectedAt: now
      });
      await booted.deps.db.insert(utxos).values({
        id: `${"ab".repeat(32)}:0`,
        transactionId: txId,
        chainId: BTC_CHAIN_ID,
        address: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        vout: 0,
        valueSats: "150000",
        scriptPubkey: "0014" + "ff".repeat(20),
        spentInPayoutId: null,
        spentAt: null,
        createdAt: now
      });

      const snapshot = await computeBalanceSnapshot(booted.deps);
      expect(snapshot.source).toBe("db");

      const utxoFamily = snapshot.families.find((f) => f.family === "utxo");
      expect(utxoFamily).toBeDefined();
      const btcChain = utxoFamily!.chains.find((c) => c.chainId === BTC_CHAIN_ID);
      expect(btcChain).toBeDefined();
      const btcRoll = btcChain!.tokens.find((t) => t.token === "BTC");
      expect(btcRoll).toBeDefined();
      expect(btcRoll!.amountRaw).toBe("150000");

      const addrRow = btcChain!.addresses.find((a) => a.address === invoice.receiveAddress);
      expect(addrRow).toBeDefined();
      expect(addrRow!.kind).toBe("pool");
      expect(addrRow!.tokens).toHaveLength(1);
      expect(addrRow!.tokens[0]!.token).toBe("BTC");
      expect(addrRow!.tokens[0]!.amountRaw).toBe("150000");
    } finally {
      await booted.close();
    }
  });

  it("hides UTXOs once they are marked spent", async () => {
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: noopEsplora() });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const invRes = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
        })
      );
      const invoice = (
        (await invRes.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }
      ).invoice;

      const now = booted.deps.clock.now().getTime();
      const txId = "tx-utxo-spent";
      await booted.deps.db.insert(transactions).values({
        id: txId,
        invoiceId: invoice.id,
        chainId: BTC_CHAIN_ID,
        txHash: "cd".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        toAddress: invoice.receiveAddress,
        token: "BTC",
        amountRaw: "200000",
        blockNumber: 200,
        confirmations: 12,
        status: "confirmed",
        detectedAt: now
      });
      const utxoId = `${"cd".repeat(32)}:0`;
      await booted.deps.db.insert(utxos).values({
        id: utxoId,
        transactionId: txId,
        chainId: BTC_CHAIN_ID,
        address: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        vout: 0,
        valueSats: "200000",
        scriptPubkey: "0014" + "ff".repeat(20),
        spentInPayoutId: null,
        spentAt: null,
        createdAt: now
      });

      const before = await computeBalanceSnapshot(booted.deps);
      expect(before.families.find((f) => f.family === "utxo")).toBeDefined();

      // Mark the utxo as consumed by a payout. The FK on `spent_in_payout_id`
      // is enforced, so we insert a real payout row first (status doesn't
      // matter for the snapshot — the WHERE clause only checks
      // `spent_in_payout_id IS NULL`).
      const payoutId = "payout-test-1";
      await booted.deps.db.insert(payouts).values({
        id: payoutId,
        merchantId: MERCHANT_ID,
        kind: "standard",
        status: "submitted",
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "150000",
        destinationAddress: "bc1qdestxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        createdAt: now,
        updatedAt: now
      });
      await booted.deps.db
        .update(utxos)
        .set({ spentInPayoutId: payoutId, spentAt: now })
        .where(eq(utxos.id, utxoId));

      const after = await computeBalanceSnapshot(booted.deps);
      expect(after.families.find((f) => f.family === "utxo")).toBeUndefined();
    } finally {
      await booted.close();
    }
  });

  it("excludes UTXOs whose parent transaction is not confirmed", async () => {
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: noopEsplora() });
    const booted = await bootTestApp({
      chains: [adapter],
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const invRes = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
        })
      );
      const invoice = (
        (await invRes.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }
      ).invoice;

      const now = booted.deps.clock.now().getTime();
      const txId = "tx-utxo-detected";
      await booted.deps.db.insert(transactions).values({
        id: txId,
        invoiceId: invoice.id,
        chainId: BTC_CHAIN_ID,
        txHash: "ef".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qsenderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        toAddress: invoice.receiveAddress,
        token: "BTC",
        amountRaw: "300000",
        blockNumber: null,
        confirmations: 0,
        status: "detected",
        detectedAt: now
      });
      await booted.deps.db.insert(utxos).values({
        id: `${"ef".repeat(32)}:0`,
        transactionId: txId,
        chainId: BTC_CHAIN_ID,
        address: invoice.receiveAddress,
        addressIndex: invoice.addressIndex,
        vout: 0,
        valueSats: "300000",
        scriptPubkey: "0014" + "ff".repeat(20),
        spentInPayoutId: null,
        spentAt: null,
        createdAt: now
      });

      const snapshot = await computeBalanceSnapshot(booted.deps);
      expect(snapshot.families.find((f) => f.family === "utxo")).toBeUndefined();
    } finally {
      await booted.close();
    }
  });
});
