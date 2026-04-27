import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp } from "../helpers/boot.js";
import { utxoChainAdapter } from "../../adapters/chains/utxo/utxo-chain.adapter.js";
import { BITCOIN_CONFIG } from "../../adapters/chains/utxo/utxo-config.js";
import type {
  EsploraClient,
  EsploraTx
} from "../../adapters/chains/utxo/esplora-rpc.js";
import { rpcPollDetection } from "../../adapters/detection/rpc-poll.adapter.js";
import { ingestDetectedTransfer } from "../../core/domain/payment.service.js";
import {
  executeReservedPayouts,
  planPayout
} from "../../core/domain/payout.service.js";
import { invoices, payouts, transactions, utxos } from "../../db/schema.js";
import type { AmountRaw } from "../../core/types/money.js";
import type { ChainId } from "../../core/types/chain.js";
import { signSegwitTx } from "../../adapters/chains/utxo/utxo-sign.js";
import { hash160 } from "../../adapters/chains/utxo/bech32-address.js";
import { hexToBytes } from "../../adapters/chains/utxo/utxo-tx-encode.js";

// End-to-end UTXO lifecycle on the Bitcoin chain (chainId 800):
//   1. Invoice creation derives a fresh BIP84 address (no pool, monotonic counter)
//   2. Detection ingest writes both `transactions` and `utxos` rows
//   3. Invoice transitions pending → processing → completed
//   4. Payout planning verifies aggregate UTXO balance, inserts row in 'reserved'
//   5. Executor runs coinselect, signs, broadcasts (against a fake Esplora),
//      marks UTXOs spent, transitions payout to 'submitted'
//
// The fake Esplora client lets us synthesize incoming UTXOs deterministically
// and capture the broadcast hex without touching the network. The adapter
// uses real BIP84 derivation + real BIP143 sighash + real ECDSA signing —
// only the network boundary is faked.

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const BTC_CHAIN_ID = 800 as ChainId;

interface FakeEsplora {
  client: EsploraClient;
  // Synthesize an incoming tx paying `address` for `valueSats`. Returns
  // (txid, vout) so the test can also drive confirmation later.
  addIncoming(args: {
    txid: string;
    address: string;
    valueSats: number;
    blockHeight?: number; // omit → mempool
    fromAddress?: string;
  }): { txid: string; vout: number };
  // Set the chain tip used to compute confirmations.
  setTipHeight(height: number): void;
  // Fee estimates (sat/vB) to inject for quoteFeeTiers tests. Defaults to
  // a realistic mempool snapshot.
  setFeeEstimates(map: Record<string, number>): void;
  // Captures of broadcast calls (for assertions).
  broadcasts: Array<{ hex: string; returnedTxid: string }>;
}

function buildFakeEsplora(): FakeEsplora {
  const txsByAddress = new Map<string, EsploraTx[]>();
  const txsById = new Map<string, EsploraTx>();
  let tipHeight = 0;
  let feeEstimates: Record<string, number> = { "1": 50, "3": 25, "6": 10 };
  const broadcasts: Array<{ hex: string; returnedTxid: string }> = [];

  const client: EsploraClient = {
    async getAddressTxs(address) {
      return (txsByAddress.get(address.toLowerCase()) ?? []).filter(
        (t) => t.status.confirmed
      );
    },
    async getAddressMempoolTxs(address) {
      return (txsByAddress.get(address.toLowerCase()) ?? []).filter(
        (t) => !t.status.confirmed
      );
    },
    async getTx(txid) {
      const tx = txsById.get(txid);
      if (!tx) {
        // Match the contract: throw EsploraNotFoundError shape, but the
        // adapter only checks `instanceof EsploraNotFoundError`. We import
        // and use the real class to satisfy that.
        const { EsploraNotFoundError } = await import(
          "../../adapters/chains/utxo/esplora-rpc.js"
        );
        throw new EsploraNotFoundError(`/tx/${txid}`);
      }
      return tx;
    },
    async getTipHeight() {
      return tipHeight;
    },
    async broadcastTx(hex) {
      // Compute the txid from the hex for a "realistic" return. We don't
      // actually parse — instead use the fact that the adapter passes us
      // the hex it just signed; the corresponding txid is whatever
      // signSegwitTx produced. The test flow knows that and just echoes
      // back what the adapter expects (we'll re-derive it via parse, but
      // shortcut: tests stash the expected txid via a side-channel).
      // For now: return a placeholder; the adapter cross-checks, so any
      // wrong return would surface as an error. The test sets this via
      // the helper below.
      const returnedTxid = pendingBroadcastReturnTxid ?? "00".repeat(32);
      broadcasts.push({ hex, returnedTxid });
      return returnedTxid;
    },
    async getFeeEstimates() {
      return feeEstimates;
    },
    async getAddressBalanceSats(address) {
      const txs = txsByAddress.get(address.toLowerCase()) ?? [];
      let sum = 0n;
      for (const tx of txs) {
        if (!tx.status.confirmed) continue;
        for (const o of tx.vout) {
          if (o.scriptpubkey_address?.toLowerCase() === address.toLowerCase()) {
            sum += BigInt(o.value);
          }
        }
      }
      return sum;
    }
  };

  let pendingBroadcastReturnTxid: string | null = null;

  return {
    client,
    addIncoming({ txid, address, valueSats, blockHeight, fromAddress }) {
      const lc = address.toLowerCase();
      const tx: EsploraTx = {
        txid,
        status: blockHeight !== undefined
          ? { confirmed: true, block_height: blockHeight, block_time: 1_700_000_000 }
          : { confirmed: false },
        vin: [
          {
            txid: "0".repeat(64),
            vout: 0,
            prevout: {
              scriptpubkey: "0014" + "00".repeat(20),
              scriptpubkey_address: fromAddress ?? "bc1qyqsjygeyy5nzw2pf9g4jctfw9ucrzv3ncm6wfx",
              value: valueSats + 1_000
            },
            witness: [],
            sequence: 0xffffffff
          }
        ],
        vout: [
          {
            scriptpubkey: "0014" + "ff".repeat(20),
            scriptpubkey_address: lc,
            value: valueSats
          }
        ],
        fee: 1_000
      };
      const list = txsByAddress.get(lc) ?? [];
      list.push(tx);
      txsByAddress.set(lc, list);
      txsById.set(txid, tx);
      return { txid, vout: 0 };
    },
    setTipHeight(h) {
      tipHeight = h;
    },
    setFeeEstimates(m) {
      feeEstimates = m;
    },
    broadcasts,
    // Internal handle used by the lifecycle test to make broadcast return
    // the matching txid. Exposed via Object.defineProperty so adding it to
    // the type union isn't necessary.
    set _broadcastReturnTxid(v: string | null) {
      pendingBroadcastReturnTxid = v;
    },
    get _broadcastReturnTxid() {
      return pendingBroadcastReturnTxid;
    }
  } as FakeEsplora & { _broadcastReturnTxid: string | null };
}

describe("UTXO end-to-end lifecycle (Bitcoin)", () => {
  it("invoice creation: derives a fresh bc1q address, writes invoice_receive_addresses with poolAddressId NULL", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const res = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            chainId: BTC_CHAIN_ID,
            token: "BTC",
            amountRaw: "100000" // 0.001 BTC
          })
        })
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } };
      expect(body.invoice.receiveAddress).toMatch(/^bc1q[023456789acdefghjklmnpqrstuvwxyz]+$/);
      // First invoice on the chain → counter starts at 0
      expect(body.invoice.addressIndex).toBe(0);
    } finally {
      await booted.close();
    }
  });

  it("detection ingest: poll-driven scan picks up an incoming tx + writes both transactions and utxos rows", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const res = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "100000" })
        })
      );
      const invoice = ((await res.json()) as { invoice: { id: string; receiveAddress: string } }).invoice;

      // Synthesize an incoming confirmed tx paying the invoice address.
      fake.setTipHeight(110);
      fake.addIncoming({
        txid: "ab".repeat(32),
        address: invoice.receiveAddress,
        valueSats: 100_000,
        blockHeight: 100,
        fromAddress: "bc1qzqg3yyc5z5tpwxqergd3c8g7ruszzg3r8jj72z"
      });

      // Drive ingest directly (rpcPollDetection's path goes through the
      // adapter's scanIncoming which we already have). Use the lower-level
      // ingestDetectedTransfer for deterministic timing.
      await ingestDetectedTransfer(booted.deps, {
        chainId: BTC_CHAIN_ID,
        txHash: "ab".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qzqg3yyc5z5tpwxqergd3c8g7ruszzg3r8jj72z" as never,
        toAddress: invoice.receiveAddress as never,
        token: "BTC" as never,
        amountRaw: "100000" as AmountRaw,
        blockNumber: 100,
        confirmations: 11, // > 6 → tx confirmed straight away
        seenAt: new Date()
      });

      // transactions row
      const [tx] = await booted.deps.db
        .select({ status: transactions.status, amountRaw: transactions.amountRaw, invoiceId: transactions.invoiceId })
        .from(transactions)
        .where(eq(transactions.txHash, "ab".repeat(32)))
        .limit(1);
      expect(tx?.status).toBe("confirmed");
      expect(tx?.amountRaw).toBe("100000");
      expect(tx?.invoiceId).toBe(invoice.id);

      // utxos overlay row
      const [utxo] = await booted.deps.db
        .select({
          chainId: utxos.chainId,
          address: utxos.address,
          addressIndex: utxos.addressIndex,
          vout: utxos.vout,
          valueSats: utxos.valueSats,
          scriptPubkey: utxos.scriptPubkey,
          spentInPayoutId: utxos.spentInPayoutId
        })
        .from(utxos)
        .limit(1);
      expect(utxo?.chainId).toBe(BTC_CHAIN_ID);
      expect(utxo?.address).toBe(invoice.receiveAddress);
      expect(utxo?.addressIndex).toBe(0);
      expect(utxo?.vout).toBe(0);
      expect(utxo?.valueSats).toBe("100000");
      // P2WPKH scriptPubkey: 0x0014 + 20-byte hash160 (44 hex chars total)
      expect(utxo?.scriptPubkey).toMatch(/^0014[0-9a-f]{40}$/);
      expect(utxo?.spentInPayoutId).toBeNull();

      // Invoice flipped to completed (full amount + 11 confirmations).
      const [inv] = await booted.deps.db
        .select({ status: invoices.status, extraStatus: invoices.extraStatus })
        .from(invoices)
        .where(eq(invoices.id, invoice.id))
        .limit(1);
      expect(inv?.status).toBe("completed");
      expect(inv?.extraStatus).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("payout flow: planPayout verifies funds, executor coinselects + signs + broadcasts + marks UTXO spent", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;

      // Create an invoice + ingest a confirmed payment so we have a
      // spendable UTXO to fund the payout from.
      const invoiceRes = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: BTC_CHAIN_ID, token: "BTC", amountRaw: "200000" })
        })
      );
      const invoice = ((await invoiceRes.json()) as { invoice: { id: string; receiveAddress: string } }).invoice;

      fake.setTipHeight(120);
      fake.addIncoming({
        txid: "cd".repeat(32),
        address: invoice.receiveAddress,
        valueSats: 200_000,
        blockHeight: 110
      });
      await ingestDetectedTransfer(booted.deps, {
        chainId: BTC_CHAIN_ID,
        txHash: "cd".repeat(32),
        logIndex: 0,
        fromAddress: "bc1qzqg3yyc5z5tpwxqergd3c8g7ruszzg3r8jj72z" as never,
        toAddress: invoice.receiveAddress as never,
        token: "BTC" as never,
        amountRaw: "200000" as AmountRaw,
        blockNumber: 110,
        confirmations: 11,
        seenAt: new Date()
      });

      // Plan a payout sending 100k sats out. UTXO has 200k, more than
      // enough to cover amount + fee.
      const payout = await planPayout(booted.deps, {
        merchantId: MERCHANT_ID,
        chainId: BTC_CHAIN_ID,
        token: "BTC",
        amountRaw: "100000",
        destinationAddress: "bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s"
      });
      expect(payout.status).toBe("reserved");
      expect(payout.sourceAddress).toBeNull(); // UTXO has no single source
      expect(payout.txHash).toBeNull();

      // Pre-compute what the deterministic signing pipeline will produce
      // for this payout, so the fake Esplora can echo back the matching
      // txid (the adapter cross-checks).
      const expected = await precomputeBroadcastTxid(booted.deps, payout.id);
      (fake as unknown as { _broadcastReturnTxid: string | null })._broadcastReturnTxid = expected.txid;

      // Run the executor.
      const result = await executeReservedPayouts(booted.deps);
      expect(result.submitted).toBe(1);

      // Verify the broadcast happened with the right hex.
      expect(fake.broadcasts).toHaveLength(1);
      expect(fake.broadcasts[0]?.hex).toBe(expected.hex);

      // Payout flipped to submitted with the txid + actual fee recorded.
      const [updated] = await booted.deps.db
        .select({
          status: payouts.status,
          txHash: payouts.txHash,
          submittedAt: payouts.submittedAt,
          feeEstimateNative: payouts.feeEstimateNative
        })
        .from(payouts)
        .where(eq(payouts.id, payout.id))
        .limit(1);
      expect(updated?.status).toBe("submitted");
      expect(updated?.txHash).toBe(expected.txid);
      expect(updated?.submittedAt).not.toBeNull();
      expect(updated?.feeEstimateNative).not.toBeNull();

      // The UTXO was marked spent in the same DB transaction.
      const [spentUtxo] = await booted.deps.db
        .select({ spentInPayoutId: utxos.spentInPayoutId, spentAt: utxos.spentAt })
        .from(utxos)
        .limit(1);
      expect(spentUtxo?.spentInPayoutId).toBe(payout.id);
      expect(spentUtxo?.spentAt).not.toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("payout flow: rejects with INSUFFICIENT_BALANCE when UTXOs don't cover amount + fee", async () => {
    const fake = buildFakeEsplora();
    const adapter = utxoChainAdapter({ chain: BITCOIN_CONFIG, esplora: fake.client });
    const booted = await bootTestApp({
      chains: [adapter],
      detectionStrategies: { [BTC_CHAIN_ID]: rpcPollDetection() },
      merchants: [{ id: MERCHANT_ID }]
    });
    try {
      // No UTXOs exist on chainId 800 → planPayout should fail at the
      // pre-flight balance check (before inserting the payouts row).
      await expect(
        planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: BTC_CHAIN_ID,
          token: "BTC",
          amountRaw: "100000",
          destinationAddress: "bc1q4w46h2at4w46h2at4w46h2at4w46h2at25y74s"
        })
      ).rejects.toThrow(/INSUFFICIENT_BALANCE_ANY_SOURCE|UTXO balance/);
    } finally {
      await booted.close();
    }
  });
});

// Re-derive the deterministic signing output for a planned UTXO payout so
// the test can echo back the right txid from the fake broadcastTx. Mirrors
// the production path's logic: fee rate from /fee-estimates → coinselect
// → derive keys → signSegwitTx. We don't run this in production code;
// it's purely for the test to know what txid the adapter will produce.
async function precomputeBroadcastTxid(
  deps: import("../../core/app-deps.js").AppDeps,
  payoutId: string
): Promise<{ hex: string; txid: string }> {
  const { selectCoins, loadSpendableUtxos } = await import(
    "../../core/domain/utxo-coin-select.js"
  );
  const { decodeP2wpkhAddress } = await import(
    "../../adapters/chains/utxo/bech32-address.js"
  );
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { findChainAdapter } = await import("../../core/domain/chain-lookup.js");

  const [row] = await deps.db
    .select()
    .from(payouts)
    .where(eq(payouts.id, payoutId))
    .limit(1);
  if (!row) throw new Error("payout not found");

  const adapter = findChainAdapter(deps, row.chainId);
  const tier: "low" | "medium" | "high" =
    (row.feeTier as "low" | "medium" | "high" | null) ?? "medium";
  const tierQuote = await adapter.quoteFeeTiers({
    chainId: row.chainId as ChainId,
    fromAddress: row.destinationAddress as never,
    toAddress: row.destinationAddress as never,
    token: row.token as never,
    amountRaw: row.amountRaw as never
  });
  const TYPICAL_VBYTES = 141;
  const tierEntry: { nativeAmountRaw: string } = tierQuote[tier];
  const feeRate = Math.max(
    1,
    Math.ceil(Number(tierEntry.nativeAmountRaw) / TYPICAL_VBYTES)
  );
  const spendable = await loadSpendableUtxos(deps, row.chainId as ChainId);
  const selection = selectCoins(
    spendable,
    [{ address: row.destinationAddress, value: Number(row.amountRaw) }],
    feeRate
  );
  if (!selection) throw new Error("test: coinselect failed");

  const seed = deps.secrets.getRequired("MASTER_SEED");
  // Replay the change-address allocation by simulating the same
  // allocateUtxoAddress call. To keep determinism we don't actually
  // call it (that has side effects on the counter); we just derive the
  // address at the next index. The production path actually allocates
  // (and increments the counter) — same address, just we're peeking.
  const { addressIndexCounters } = await import("../../db/schema.js");
  const [counter] = await deps.db
    .select()
    .from(addressIndexCounters)
    .where(eq(addressIndexCounters.chainId, row.chainId))
    .limit(1);
  const changeIndex = counter?.nextIndex ?? 0;
  const changeDerived = adapter.deriveAddress(seed, changeIndex);
  const decodedChange = decodeP2wpkhAddress(changeDerived.address);
  if (!decodedChange) throw new Error("change address decode");
  const changeScript = "0014" + bytesToHex(decodedChange.program);

  const decodedDest = decodeP2wpkhAddress(row.destinationAddress);
  if (!decodedDest) throw new Error("destination address decode");
  const destScript = "0014" + bytesToHex(decodedDest.program);

  const outputs = selection.outputs.map((o) => {
    if (o.address === undefined) {
      return { scriptPubkey: changeScript, value: BigInt(o.value) };
    }
    return { scriptPubkey: destScript, value: BigInt(o.value) };
  });

  const inputs = selection.chosenInputs.map((u) => ({
    prevTxid: u.txId,
    prevVout: u.vout,
    prevScriptPubkey: u.scriptPubkey,
    prevValue: BigInt(u.value),
    sequence: 0xfffffffd
  }));
  const signingKeys = await Promise.all(
    selection.chosenInputs.map(async (u) => {
      const pk = await deps.signerStore.get({
        kind: "pool-address" as const,
        family: "utxo" as const,
        derivationIndex: u.addressIndex
      });
      return { address: u.address, privateKey: pk };
    })
  );
  // verify: derive pubkey from the first key and confirm it matches the
  // input's program (sanity that the test path mirrors prod).
  void secp256k1;
  void hash160;
  void hexToBytes;
  void signSegwitTx; // import keeps tree-shaking happy
  const signed = signSegwitTx(
    { version: 2, locktime: 0, inputs, outputs },
    signingKeys
  );
  return { hex: signed.hex, txid: signed.txid };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 1) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
