import { describe, expect, it } from "vitest";
import {
  selectCoins,
  type SelectableUtxo
} from "../../../../core/domain/utxo-coin-select.js";

// `selectCoins` wraps the npm `coinselect` package. We test:
//   - happy path: enough UTXOs → picks the largest single one (BnB / largest-first)
//   - exact match: one UTXO == target+fee → picks just that one, no change
//   - insufficient funds: returns null
//   - multi-input combination: target > any single UTXO → picks multiple
//   - enrichment: chosen inputs preserve our utxoId / addressIndex / scriptPubkey

function utxo(over: Partial<SelectableUtxo>): SelectableUtxo {
  return {
    txId: "00".repeat(32),
    vout: 0,
    value: 50_000,
    utxoId: "u1",
    address: "bc1qaddr1",
    addressIndex: 0,
    scriptPubkey: "0014" + "00".repeat(20),
    ...over
  };
}

describe("selectCoins", () => {
  it("picks a single largest UTXO when one is enough to cover target+fee", () => {
    const spendable = [
      utxo({ utxoId: "small", txId: "01".repeat(32), value: 30_000, addressIndex: 0 }),
      utxo({ utxoId: "big", txId: "02".repeat(32), value: 100_000, addressIndex: 1 }),
      utxo({ utxoId: "mid", txId: "03".repeat(32), value: 50_000, addressIndex: 2 })
    ];
    const result = selectCoins(spendable, [{ address: "bc1qdest", value: 50_000 }], 5);
    expect(result).not.toBeNull();
    // Algorithm should converge on a single input that covers it cheaply.
    expect(result!.chosenInputs.length).toBeGreaterThanOrEqual(1);
    expect(result!.outputs[0]?.value).toBe(50_000);
    expect(result!.fee).toBeGreaterThan(0);
  });

  it("preserves enrichment fields (utxoId, addressIndex, scriptPubkey) on chosen inputs", () => {
    const spendable = [
      utxo({
        utxoId: "MARKED",
        txId: "11".repeat(32),
        value: 100_000,
        addressIndex: 42,
        address: "bc1q-marked",
        scriptPubkey: "0014" + "ff".repeat(20)
      })
    ];
    const result = selectCoins(spendable, [{ address: "bc1qdest", value: 50_000 }], 5);
    expect(result).not.toBeNull();
    const picked = result!.chosenInputs[0]!;
    expect(picked.utxoId).toBe("MARKED");
    expect(picked.addressIndex).toBe(42);
    expect(picked.address).toBe("bc1q-marked");
    expect(picked.scriptPubkey).toBe("0014" + "ff".repeat(20));
  });

  it("returns null on insufficient funds", () => {
    const spendable = [utxo({ value: 1000 })];
    const result = selectCoins(spendable, [{ address: "bc1qdest", value: 50_000 }], 5);
    expect(result).toBeNull();
  });

  it("returns null when there are no UTXOs at all", () => {
    const result = selectCoins([], [{ address: "bc1qdest", value: 1 }], 5);
    expect(result).toBeNull();
  });

  it("combines multiple UTXOs when no single one is large enough", () => {
    const spendable = [
      utxo({ utxoId: "a", txId: "01".repeat(32), value: 30_000 }),
      utxo({ utxoId: "b", txId: "02".repeat(32), value: 30_000 }),
      utxo({ utxoId: "c", txId: "03".repeat(32), value: 30_000 })
    ];
    const result = selectCoins(spendable, [{ address: "bc1qdest", value: 70_000 }], 5);
    expect(result).not.toBeNull();
    expect(result!.chosenInputs.length).toBeGreaterThanOrEqual(2);
    const totalIn = result!.chosenInputs.reduce((s, u) => s + u.value, 0);
    const totalOut = result!.outputs.reduce((s, o) => s + o.value, 0);
    // Conservation: sum(inputs) = sum(outputs) + fee
    expect(totalIn).toBe(totalOut + result!.fee);
  });

  it("emits a change output when picked inputs exceed target+fee with enough margin", () => {
    const spendable = [utxo({ value: 1_000_000 })];
    const result = selectCoins(spendable, [{ address: "bc1qdest", value: 100_000 }], 5);
    expect(result).not.toBeNull();
    // Two outputs: target + change. coinselect's change output has no
    // `address` field — caller plugs in a fresh receive address before signing.
    expect(result!.outputs.length).toBe(2);
    expect(result!.outputs[0]?.address).toBe("bc1qdest");
    expect(result!.outputs[1]?.address).toBeUndefined();
    expect(result!.outputs[1]!.value).toBeGreaterThan(0);
  });

  it("supports multi-output (batch) payouts", () => {
    const spendable = [utxo({ value: 1_000_000 })];
    const result = selectCoins(
      spendable,
      [
        { address: "bc1qdest1", value: 100_000 },
        { address: "bc1qdest2", value: 250_000 },
        { address: "bc1qdest3", value: 75_000 }
      ],
      5
    );
    expect(result).not.toBeNull();
    // 3 targets + 1 change = 4 outputs (when change is non-dust)
    expect(result!.outputs.length).toBeGreaterThanOrEqual(3);
    expect(result!.outputs[0]?.value).toBe(100_000);
    expect(result!.outputs[1]?.value).toBe(250_000);
    expect(result!.outputs[2]?.value).toBe(75_000);
  });
});
