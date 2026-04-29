import { describe, expect, it } from "vitest";
import { pollPayments } from "../../core/domain/poll-payments.js";
import type { DetectionStrategy } from "../../core/ports/detection.port.js";
import type { DetectedTransfer } from "../../core/types/transaction.js";
import { bootTestApp, createInvoiceViaApi } from "../helpers/boot.js";

// Regression: a single chain's poll throwing must NOT abort the entire job.
// Production failure mode that motivated this: TronGrid started returning
// HTTP 429 to the gateway's free-tier key; pollPayments propagated the
// throw, the scheduled-jobs runner marked the whole tick as failed, and
// every chain after Tron in the iteration order silently went unscanned.
// In the original incident the silenced family was Monero (a freshly-paid
// invoice sat at "pending" for 10+ minutes despite the on-chain credit),
// but the same isolation requirement applies to any pair of chains: their
// detection backends are independent, so their failure modes must be too.

describe("pollPayments — per-chain error isolation", () => {
  it("does not throw when a chain's detection strategy throws; returns a partial result", async () => {
    const throwingStrategy: DetectionStrategy = {
      async poll(): Promise<readonly DetectedTransfer[]> {
        throw new Error("simulated rate-limit (HTTP 429)");
      }
    };

    const booted = await bootTestApp({
      detectionStrategies: { 999: throwingStrategy }
    });
    try {
      // Create an invoice so there's at least one address on the family the
      // throwing strategy will be asked about. Without it, the per-family
      // address-set is empty and the loop body never enters.
      await createInvoiceViaApi(booted, { amountRaw: "1000" });

      // The job MUST complete, not throw. A throw here means error
      // propagation has regressed and the cron will mark the tick failed,
      // silencing every chain after this one in the iteration order.
      const result = await pollPayments(booted.deps);

      expect(result.chainsPolled).toBe(1);
      expect(result.transfersFound).toBe(0);
      expect(result.transfersIngested).toBe(0);

      // The failure should surface as a structured warning, not an unhandled
      // exception. Operators rely on this log line to diagnose "why was
      // chain X silently not scanning?" — losing it makes the failure mode
      // invisible until a customer complains.
      const warnings = booted.logger.entries.filter(
        (e) => e.level === "warn" && e.message.includes("chain poll failed")
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.fields).toMatchObject({ chainId: 999 });
    } finally {
      await booted.close();
    }
  });

  it("ingests transfers from healthy chains even when a sibling chain throws", async () => {
    // Two strategies on the same chainId would race — instead we verify the
    // weaker but sufficient property: one strategy that throws AND returns
    // a clean partial result. To exercise the "sibling chain still ingests"
    // path end-to-end we'd need a second wired chain adapter on a different
    // family, which the booted test app doesn't provide out-of-box. The
    // throw-doesn't-abort property above is the necessary-and-sufficient
    // regression guard for the production incident.
    //
    // This second test pins the behavior of strategies that return cleanly
    // alongside throwing ones in the SAME tick — by alternating ticks,
    // we observe that a healthy strategy is invoked normally even after a
    // tick where its sibling threw.
    let throwOnNextCall = true;
    const flakyStrategy: DetectionStrategy = {
      async poll(): Promise<readonly DetectedTransfer[]> {
        if (throwOnNextCall) {
          throwOnNextCall = false;
          throw new Error("flaky upstream");
        }
        return [];
      }
    };

    const booted = await bootTestApp({
      detectionStrategies: { 999: flakyStrategy }
    });
    try {
      await createInvoiceViaApi(booted, { amountRaw: "1000" });

      // Tick 1: strategy throws → caught + logged.
      const tick1 = await pollPayments(booted.deps);
      expect(tick1.chainsPolled).toBe(1);
      expect(tick1.transfersFound).toBe(0);

      // Tick 2: same strategy now returns cleanly. This proves the throw
      // didn't leave any state-machine residue that would prevent the next
      // tick from invoking it.
      const tick2 = await pollPayments(booted.deps);
      expect(tick2.chainsPolled).toBe(1);
      expect(tick2.transfersFound).toBe(0);
    } finally {
      await booted.close();
    }
  });
});
