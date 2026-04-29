import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { eq } from "drizzle-orm";
import { bootTestApp } from "../helpers/boot.js";
import {
  encodeAddress,
  parseAddress
} from "../../adapters/chains/monero/monero-crypto.js";
import { moneroChainAdapter } from "../../adapters/chains/monero/monero-chain.adapter.js";
import { MONERO_MAINNET_CONFIG } from "../../adapters/chains/monero/monero-config.js";
import type {
  MoneroDaemonRpcClient,
  MoneroParsedTx
} from "../../adapters/chains/monero/monero-rpc.js";
import { invoiceReceiveAddresses } from "../../db/schema.js";
import { planPayout } from "../../core/domain/payout.service.js";

// Monero (XMR) inbound integration tests. Cover:
//   1. Adapter construction validates view key ↔ primary address.
//      Mismatch → throws with a clear error.
//   2. Invoice creation with `acceptedFamilies: ["monero"]` mints a unique
//      subaddress per invoice, persists it on `invoice_receive_addresses`
//      with `family='monero', addressIndex=N`. Counter increments.
//   3. Without the Monero adapter wired, an invoice with
//      `acceptedFamilies: ["monero"]` fails at create with the standard
//      "no chain adapter wired" error.
//   4. planPayout for a Monero chainId throws PAYOUT_NOT_SUPPORTED_ON_FAMILY
//      (v1 inbound-only).

const ED25519_L = ed25519.Point.Fn.ORDER;

// Build a deterministic test wallet — same shape as the unit tests but
// surfaced here so we can pass it into the chain adapter at boot.
function leBytesToBigIntMod(bytes: Uint8Array, modulus: bigint): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]!);
  return n % modulus;
}

function scalarToLEBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeWallet(seedSuffix: string): {
  primaryAddress: string;
  viewKey: Uint8Array;
  primarySpendPub: Uint8Array;
} {
  const spendSeed = keccak_256(new TextEncoder().encode(`monero-itest-spend-${seedSuffix}`));
  const viewSeed = keccak_256(new TextEncoder().encode(`monero-itest-view-${seedSuffix}`));
  let spendScalar = 0n;
  let viewScalar = 0n;
  for (let i = spendSeed.length - 1; i >= 0; i -= 1) spendScalar = (spendScalar << 8n) | BigInt(spendSeed[i]!);
  for (let i = viewSeed.length - 1; i >= 0; i -= 1) viewScalar = (viewScalar << 8n) | BigInt(viewSeed[i]!);
  spendScalar %= ED25519_L;
  viewScalar %= ED25519_L;
  const viewKey = new Uint8Array(32);
  let v = viewScalar;
  for (let i = 0; i < 32; i += 1) {
    viewKey[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const primarySpendPub = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const publicViewKey = ed25519.Point.BASE.multiply(viewScalar).toBytes();
  const primaryAddress = encodeAddress({
    network: "mainnet",
    isSubaddress: false,
    publicSpendKey: primarySpendPub,
    publicViewKey
  });
  return { primaryAddress, viewKey, primarySpendPub };
}

// Stub daemon RPC: invoice-create + planPayout don't actually call any
// daemon methods, so a thin "throws on use" client is enough.
function stubDaemonClient(): MoneroDaemonRpcClient {
  const fail = () => {
    throw new Error("monero daemon RPC not used in this test");
  };
  return {
    getTipHeight: fail,
    getBlockTxHashesByHeight: fail,
    getTransactions: fail
  };
}

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";
const MONERO_CHAIN_ID = MONERO_MAINNET_CONFIG.chainId;

describe("Monero adapter — boot validation", () => {
  it("rejects a view key that doesn't correspond to the primary address", async () => {
    const w = makeWallet("ok");
    const wrong = makeWallet("other");
    const booted = await bootTestApp({});
    try {
      expect(() =>
        moneroChainAdapter({
          chain: MONERO_MAINNET_CONFIG,
          primaryAddress: w.primaryAddress,
          viewKey: wrong.viewKey, // belongs to a different wallet
          restoreHeight: 0,
          daemonClient: stubDaemonClient(),
          cache: booted.deps.cache
        })
      ).toThrow(/MONERO_VIEW_KEY does not correspond/);
    } finally {
      await booted.close();
    }
  });

  it("rejects a network-mismatched primary address", async () => {
    const w = makeWallet("netfail");
    // Re-encode with the stagenet network byte — same keys, different prefix.
    const parsed = parseAddress(w.primaryAddress);
    const stagenetAddr = encodeAddress({
      network: "stagenet",
      isSubaddress: false,
      publicSpendKey: parsed.publicSpendKey,
      publicViewKey: parsed.publicViewKey
    });
    const booted = await bootTestApp({});
    try {
      expect(() =>
        moneroChainAdapter({
          chain: MONERO_MAINNET_CONFIG, // expects mainnet
          primaryAddress: stagenetAddr,
          viewKey: w.viewKey,
          restoreHeight: 0,
          daemonClient: stubDaemonClient(),
          cache: booted.deps.cache
        })
      ).toThrow(/network mismatch/);
    } finally {
      await booted.close();
    }
  });

  it("rejects a subaddress as the primary (must be a primary, not a subaddress)", async () => {
    const w = makeWallet("subasprime");
    const parsed = parseAddress(w.primaryAddress);
    const subasprime = encodeAddress({
      network: "mainnet",
      isSubaddress: true, // intentionally wrong
      publicSpendKey: parsed.publicSpendKey,
      publicViewKey: parsed.publicViewKey
    });
    const booted = await bootTestApp({});
    try {
      expect(() =>
        moneroChainAdapter({
          chain: MONERO_MAINNET_CONFIG,
          primaryAddress: subasprime,
          viewKey: w.viewKey,
          restoreHeight: 0,
          daemonClient: stubDaemonClient(),
          cache: booted.deps.cache
        })
      ).toThrow(/PRIMARY address, not a subaddress/);
    } finally {
      await booted.close();
    }
  });
});

describe("Monero invoice creation", () => {
  it("mints a unique subaddress per invoice and increments the counter", async () => {
    const w = makeWallet("invoicemint");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 0,
        daemonClient: stubDaemonClient(),
        cache: booted.deps.cache
      });
      // Inject the Monero adapter into deps.chains. bootTestApp doesn't
      // wire it via env vars; we patch the in-memory deps directly.
      (booted.deps.chains as unknown as Array<typeof adapter>).push(adapter);

      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const r1 = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            chainId: MONERO_CHAIN_ID,
            token: "XMR",
            amountRaw: "100000000000" // 0.1 XMR
          })
        })
      );
      if (r1.status !== 201) {
        const errBody = await r1.text();
        const logs = booted.logger.entries.filter((e) => e.level === "error" || e.level === "warn").slice(-5);
        throw new Error(`invoice create r1 returned ${r1.status}: ${errBody}\nlogs: ${JSON.stringify(logs)}`);
      }
      const inv1 = ((await r1.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }).invoice;
      // First invoice → subaddress index 1 (index 0 is the primary).
      expect(inv1.addressIndex).toBe(1);
      // Receive address parses as a Monero subaddress on mainnet.
      const parsed1 = parseAddress(inv1.receiveAddress);
      expect(parsed1.isSubaddress).toBe(true);
      expect(parsed1.network).toBe("mainnet");

      // Second invoice → distinct subaddress, index 2.
      const r2 = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            chainId: MONERO_CHAIN_ID,
            token: "XMR",
            amountRaw: "200000000000"
          })
        })
      );
      expect(r2.status).toBe(201);
      const inv2 = ((await r2.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }).invoice;
      expect(inv2.addressIndex).toBe(2);
      expect(inv2.receiveAddress).not.toBe(inv1.receiveAddress);

      // The receive-address join row carries family='monero' and the
      // expected index — payout-side code (and operator wallet
      // reconciliation) reads this column.
      const rows = await booted.deps.db
        .select()
        .from(invoiceReceiveAddresses)
        .where(eq(invoiceReceiveAddresses.invoiceId, inv1.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.family).toBe("monero");
      expect(rows[0]!.addressIndex).toBe(1);
      expect(rows[0]!.poolAddressId).toBeNull();
    } finally {
      await booted.close();
    }
  });

  it("rejects an invoice request when the Monero adapter isn't wired", async () => {
    // Default boot has no Monero adapter — invoice creation must fail
    // with the standard "no chain adapter wired" error path.
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const res = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            chainId: MONERO_CHAIN_ID,
            token: "XMR",
            amountRaw: "100000000000"
          })
        })
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      // Could surface as TOKEN_NOT_SUPPORTED (no token registered for
      // this chainId in the deps' adapters) or a chain-not-wired flavor.
      // Either is acceptable — the contract is "non-2xx with a clear code".
      expect(body.error?.code).toBeTruthy();
    } finally {
      await booted.close();
    }
  });
});

describe("Monero detection — happy path", () => {
  it("scanIncoming decodes a synthetic block output and emits a DetectedTransfer for the matching subaddress", async () => {
    // This is the gating end-to-end test for the inbound flow. Without it,
    // a subtle bug in deriveSharedSecret / expectedOutputPubkey /
    // decodeRctAmount would silently miss every payment in production
    // and no other test would catch it.
    //
    // Plan: mint a Monero invoice (gets a subaddress at index 1), then
    // synthesize an on-chain output that pays that subaddress (using
    // the same crypto the gateway will use to decode). Stub the daemon
    // client to return a single block containing that output. Call
    // scanIncoming; assert exactly one DetectedTransfer with the right
    // amount, toAddress, and confirmations.
    const w = makeWallet("detect");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      // Stub state — the daemon-RPC stub reads from these closures so
      // the test can drive it deterministically.
      let stubTipHeight = 0;
      let stubBlockTxs = new Map<number, readonly string[]>();
      let stubTxs = new Map<string, MoneroParsedTx>();
      const daemonClient: MoneroDaemonRpcClient = {
        async getTipHeight() {
          return stubTipHeight;
        },
        async getBlockTxHashesByHeight(height) {
          return stubBlockTxs.get(height) ?? [];
        },
        async getTransactions(hashes) {
          return hashes.map((h) => stubTxs.get(h)).filter((t): t is MoneroParsedTx => t !== undefined);
        }
      };
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 100, // explicit, not zero — skips the auto-snap warning path
        daemonClient,
        cache: booted.deps.cache
      });
      (booted.deps.chains as unknown as Array<typeof adapter>).push(adapter);

      // Create an invoice. First Monero invoice → subaddress index 1.
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const created = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            chainId: MONERO_CHAIN_ID,
            token: "XMR",
            amountRaw: "150000000000" // 0.15 XMR
          })
        })
      );
      expect(created.status).toBe(201);
      const invoice = ((await created.json()) as { invoice: { id: string; receiveAddress: string; addressIndex: number } }).invoice;
      const subParsed = parseAddress(invoice.receiveAddress);

      // Synthesize an on-chain tx output paying that subaddress.
      // For subaddress recipients, sender's tx pubkey is `r · D` (NOT r · G):
      //   - Recipient computes derivation = 8 · viewSecret · txPubkey
      //                                   = 8 · viewSecret · r · D
      //                                   = 8r · (viewSecret · D)
      //                                   = 8r · subView (= C)
      //   - Same value the sender computed at signing time using `8r · C`.
      const r = leBytesToBigIntMod(
        keccak_256(new TextEncoder().encode("test-r-tx-secret")),
        ED25519_L
      );
      const D = ed25519.Point.fromBytes(subParsed.publicSpendKey);
      const txPubkeyPoint = D.multiply(r);
      const txPubkeyHex = bytesToHex(txPubkeyPoint.toBytes());

      // The output we'll inject is at outputIndex 0 of this tx.
      // Compute what the gateway's deriveSharedSecret WILL produce for it,
      // then derive the on-chain output_pubkey and encrypted amount the
      // sender would have written.
      const C = ed25519.Point.fromBytes(subParsed.publicViewKey);
      const derivationPoint = C.multiply(r).multiply(8n);
      const derivationBytes = derivationPoint.toBytes();
      // Hs(derivation || varint(0)) → reduced 32 bytes (matches the
      // gateway's deriveSharedSecret output).
      const sharedPreimage = new Uint8Array(derivationBytes.length + 1);
      sharedPreimage.set(derivationBytes, 0);
      sharedPreimage[derivationBytes.length] = 0; // varint(0) = single 0x00 byte
      const sharedScalarBytes = scalarToLEBytes32(
        leBytesToBigIntMod(keccak_256(sharedPreimage), ED25519_L)
      );
      // K_out = sharedScalar · G + subaddressSpendPub
      const sharedScalar = leBytesToBigIntMod(sharedScalarBytes, ED25519_L);
      const Kout = ed25519.Point.BASE.multiply(sharedScalar).add(D).toBytes();
      // encryptedAmount = realAmount XOR keccak("amount" || sharedScalarBytes)[0..8]
      const realAmount = 150000000000n; // 0.15 XMR (12 decimals)
      const amountPreimage = new Uint8Array("amount".length + 32);
      amountPreimage.set(new TextEncoder().encode("amount"), 0);
      amountPreimage.set(sharedScalarBytes, "amount".length);
      const amountMask = keccak_256(amountPreimage);
      const encrypted = new Uint8Array(8);
      let av = realAmount;
      for (let i = 0; i < 8; i += 1) {
        encrypted[i] = (Number(av & 0xffn) ^ amountMask[i]!) & 0xff;
        av >>= 8n;
      }

      // Wire the stub: tip = 110, target tx is in block 105.
      const txHash = "ab".repeat(32);
      stubTipHeight = 110;
      stubBlockTxs.set(105, [txHash]);
      stubTxs.set(txHash, {
        txHash,
        blockHeight: 105,
        txPubkey: txPubkeyHex,
        additionalPubkeys: [],
        isCoinbase: false,
        outputs: [
          {
            publicKey: bytesToHex(Kout),
            encryptedAmount: bytesToHex(encrypted)
          }
        ]
      });

      // Drive scanIncoming. Should detect exactly one transfer for the
      // merchant's subaddress at the right amount.
      const transfers = await adapter.scanIncoming({
        chainId: MONERO_CHAIN_ID,
        addresses: [invoice.receiveAddress as never],
        tokens: ["XMR" as never],
        sinceMs: 0
      });
      expect(transfers).toHaveLength(1);
      const t = transfers[0]!;
      expect(t.token).toBe("XMR");
      expect(t.toAddress).toBe(invoice.receiveAddress);
      expect(t.amountRaw).toBe(realAmount.toString());
      expect(t.blockNumber).toBe(105);
      expect(t.confirmations).toBe(110 - 105); // tip - blockHeight
      expect(t.txHash).toBe(txHash);
      // Sender is unknowable from the view key — the transfer must carry
      // the MONERO_UNKNOWN_SENDER sentinel. Two earlier impls broke here:
      // (1) "monero-sender" crashed canonicalizeAddress on the '-' char
      //     because '-' isn't in Monero's base58 alphabet;
      // (2) "" (empty string) violated the DetectedTransferSchema's
      //     min(1) constraint and was rejected at Zod parse.
      // The current sentinel uses underscores (also outside base58, so a
      // misuse trying to canonicalize it as an address fails loudly) but
      // is non-empty so the schema accepts it.
      expect(t.fromAddress).toBe("monero_unknown_sender");
    } finally {
      await booted.close();
    }
  });

  // Regression for the production "ingest fails on '-' in fromAddress" bug:
  // the adapter MUST canonicalize the empty-string sentinel without going
  // through base58 parse, otherwise pollPayments catches a parse error and
  // every detected Monero credit is silently dropped.
  it("canonicalizeAddress passes the empty-string sender sentinel through unchanged", async () => {
    const w = makeWallet("canon-sentinel");
    const booted = await bootTestApp({});
    try {
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 0,
        daemonClient: stubDaemonClient(),
        cache: booted.deps.cache
      });
      // Both sentinels round-trip without base58 parsing.
      expect(adapter.canonicalizeAddress("monero_unknown_sender")).toBe("monero_unknown_sender");
      expect(adapter.canonicalizeAddress("")).toBe("");
      // The validation path still rejects garbage that ISN'T the sentinel.
      expect(() => adapter.canonicalizeAddress("monero-sender")).toThrow();
      expect(() => adapter.canonicalizeAddress("not-an-address")).toThrow();
    } finally {
      await booted.close();
    }
  });

  // Regression: production wallets (Cake, Monero GUI, Feather) put the per-
  // output tx pubkey for subaddress recipients into `tx_extra` tag 0x04
  // (additional pubkeys), NOT tag 0x01 (primary). An earlier impl threw
  // additional pubkeys away and only matched against the primary, which
  // silently missed every real-world subaddress payment. This test forces
  // detection through the additional-pubkeys path: primary is a decoy that
  // points nowhere; the matching key is at additionalPubkeys[i].
  it("scanIncoming detects credits when the matching tx pubkey is in additional_pubkeys (subaddress-aware sender)", async () => {
    const w = makeWallet("detect-additional");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      let stubTipHeight = 0;
      const stubBlockTxs = new Map<number, readonly string[]>();
      const stubTxs = new Map<string, MoneroParsedTx>();
      const daemonClient: MoneroDaemonRpcClient = {
        async getTipHeight() { return stubTipHeight; },
        async getBlockTxHashesByHeight(h) { return stubBlockTxs.get(h) ?? []; },
        async getTransactions(hashes) {
          return hashes.map((h) => stubTxs.get(h)).filter((t): t is MoneroParsedTx => t !== undefined);
        }
      };
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 100,
        daemonClient,
        cache: booted.deps.cache
      });
      (booted.deps.chains as unknown as Array<typeof adapter>).push(adapter);

      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const created = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: MONERO_CHAIN_ID, token: "XMR", amountRaw: "150000000000" })
        })
      );
      expect(created.status).toBe(201);
      const invoice = ((await created.json()) as { invoice: { receiveAddress: string } }).invoice;
      const subParsed = parseAddress(invoice.receiveAddress);

      // Same crypto as the primary-pubkey test, but the matching pubkey
      // (r·D) goes in additionalPubkeys[0]; primary is a decoy point that
      // doesn't correspond to any of our subaddresses.
      const r = leBytesToBigIntMod(
        keccak_256(new TextEncoder().encode("test-additional-r-secret")),
        ED25519_L
      );
      const D = ed25519.Point.fromBytes(subParsed.publicSpendKey);
      const additionalTxPubkey = D.multiply(r).toBytes();
      const C = ed25519.Point.fromBytes(subParsed.publicViewKey);
      const derivationPoint = C.multiply(r).multiply(8n);
      const derivationBytes = derivationPoint.toBytes();
      const sharedPreimage = new Uint8Array(derivationBytes.length + 1);
      sharedPreimage.set(derivationBytes, 0);
      sharedPreimage[derivationBytes.length] = 0;
      const sharedScalarBytes = scalarToLEBytes32(
        leBytesToBigIntMod(keccak_256(sharedPreimage), ED25519_L)
      );
      const sharedScalar = leBytesToBigIntMod(sharedScalarBytes, ED25519_L);
      const Kout = ed25519.Point.BASE.multiply(sharedScalar).add(D).toBytes();
      const realAmount = 150000000000n;
      const amountPreimage = new Uint8Array("amount".length + 32);
      amountPreimage.set(new TextEncoder().encode("amount"), 0);
      amountPreimage.set(sharedScalarBytes, "amount".length);
      const amountMask = keccak_256(amountPreimage);
      const encrypted = new Uint8Array(8);
      let av = realAmount;
      for (let i = 0; i < 8; i += 1) {
        encrypted[i] = (Number(av & 0xffn) ^ amountMask[i]!) & 0xff;
        av >>= 8n;
      }

      // Decoy primary: a random unrelated point. If the adapter tried only
      // this key, it would never match the output and the test would fail
      // (which is exactly the bug we're guarding against).
      const decoyPrimary = bytesToHex(
        ed25519.Point.BASE.multiply(
          leBytesToBigIntMod(keccak_256(new TextEncoder().encode("decoy")), ED25519_L)
        ).toBytes()
      );

      const txHash = "cd".repeat(32);
      stubTipHeight = 110;
      stubBlockTxs.set(105, [txHash]);
      stubTxs.set(txHash, {
        txHash,
        blockHeight: 105,
        txPubkey: decoyPrimary,
        additionalPubkeys: [bytesToHex(additionalTxPubkey)],
        isCoinbase: false,
        outputs: [
          { publicKey: bytesToHex(Kout), encryptedAmount: bytesToHex(encrypted) }
        ]
      });

      const transfers = await adapter.scanIncoming({
        chainId: MONERO_CHAIN_ID,
        addresses: [invoice.receiveAddress as never],
        tokens: ["XMR" as never],
        sinceMs: 0
      });
      expect(transfers).toHaveLength(1);
      expect(transfers[0]!.amountRaw).toBe(realAmount.toString());
      expect(transfers[0]!.toAddress).toBe(invoice.receiveAddress);
    } finally {
      await booted.close();
    }
  });

  it("scanIncoming returns no transfers when no output matches any owned subaddress", async () => {
    // A real-world block contains thousands of outputs that DON'T belong
    // to the gateway. Confirm we silently skip them rather than emitting
    // false positives.
    const w = makeWallet("detect-miss");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      const daemonClient: MoneroDaemonRpcClient = {
        async getTipHeight() { return 105; },
        async getBlockTxHashesByHeight(h) {
          return h === 100 ? [`cd`.repeat(32)] : [];
        },
        async getTransactions(hashes) {
          // Return a tx with random output keys — none should match our
          // wallet's subaddresses.
          return hashes.map((h) => ({
            txHash: h,
            blockHeight: 100,
            txPubkey: bytesToHex(keccak_256(new TextEncoder().encode("foreign-tx-pub"))),
            additionalPubkeys: [],
            isCoinbase: false,
            outputs: [
              {
                publicKey: bytesToHex(keccak_256(new TextEncoder().encode("foreign-output"))),
                encryptedAmount: "0102030405060708"
              }
            ]
          }));
        }
      };
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 99,
        daemonClient,
        cache: booted.deps.cache
      });
      (booted.deps.chains as unknown as Array<typeof adapter>).push(adapter);

      // Create an invoice so we have at least one live subaddress to scan against.
      const apiKey = booted.apiKeys[MERCHANT_ID]!;
      const created = await booted.app.fetch(
        new Request("http://test.local/api/v1/invoices", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ chainId: MONERO_CHAIN_ID, token: "XMR", amountRaw: "10000000000" })
        })
      );
      const invoice = ((await created.json()) as { invoice: { receiveAddress: string } }).invoice;

      const transfers = await adapter.scanIncoming({
        chainId: MONERO_CHAIN_ID,
        addresses: [invoice.receiveAddress as never],
        tokens: ["XMR" as never],
        sinceMs: 0
      });
      expect(transfers).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });

  it("scanIncoming advances its checkpoint and resumes from the next block on subsequent calls", async () => {
    // Cache resumption test. Without this, every cron tick would re-scan
    // the entire range from `restoreHeight` and exponentially explode
    // the per-tick RPC load.
    const w = makeWallet("checkpoint");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      const fetchedHeights: number[] = [];
      const daemonClient: MoneroDaemonRpcClient = {
        async getTipHeight() { return 50; },
        async getBlockTxHashesByHeight(h) {
          fetchedHeights.push(h);
          return [];
        },
        async getTransactions() { return []; }
      };
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 40,
        daemonClient,
        cache: booted.deps.cache
      });
      // We need at least one parseable subaddress in `addresses` so the
      // adapter doesn't short-circuit on "no targets" before scanning.
      // Use the wallet's primary address — parses as a valid (mainnet)
      // address even though strictly the gateway only mints subaddresses.
      const validAddress = w.primaryAddress as never;

      // First call: scans blocks 40..50.
      await adapter.scanIncoming({
        chainId: MONERO_CHAIN_ID,
        addresses: [validAddress],
        tokens: ["XMR" as never],
        sinceMs: 0
      });
      const firstPass = fetchedHeights.slice();
      expect(firstPass[0]).toBe(40);
      expect(firstPass[firstPass.length - 1]).toBe(50);

      // Second call: should resume from block 51 (above tip → no fetches).
      fetchedHeights.length = 0;
      await adapter.scanIncoming({
        chainId: MONERO_CHAIN_ID,
        addresses: [validAddress],
        tokens: ["XMR" as never],
        sinceMs: 0
      });
      // Tip is still 50, lastScanned was 50 → fromHeight=51 > tip → exit.
      expect(fetchedHeights).toHaveLength(0);
    } finally {
      await booted.close();
    }
  });
});

describe("Monero payout (v1 stub)", () => {
  it("planPayout for a Monero chainId throws PAYOUT_NOT_SUPPORTED_ON_FAMILY", async () => {
    const w = makeWallet("payoutreject");
    const booted = await bootTestApp({ merchants: [{ id: MERCHANT_ID }] });
    try {
      const adapter = moneroChainAdapter({
        chain: MONERO_MAINNET_CONFIG,
        primaryAddress: w.primaryAddress,
        viewKey: w.viewKey,
        restoreHeight: 0,
        daemonClient: stubDaemonClient(),
        cache: booted.deps.cache
      });
      (booted.deps.chains as unknown as Array<typeof adapter>).push(adapter);

      // Pick any well-formed Monero address as the destination — the
      // family-guard fires before address validation.
      const destination = w.primaryAddress;
      let caught: { code?: string } | null = null;
      try {
        await planPayout(booted.deps, {
          merchantId: MERCHANT_ID,
          chainId: MONERO_CHAIN_ID,
          token: "XMR",
          amountRaw: "100000000000",
          destinationAddress: destination
        });
      } catch (err) {
        caught = err as { code?: string };
      }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe("PAYOUT_NOT_SUPPORTED_ON_FAMILY");
    } finally {
      await booted.close();
    }
  });
});
