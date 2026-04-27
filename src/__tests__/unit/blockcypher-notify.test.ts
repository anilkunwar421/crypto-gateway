import { describe, expect, it } from "vitest";
import { projectBlockcypherTx } from "../../adapters/detection/blockcypher-notify.adapter.js";
import type { ChainId } from "../../core/types/chain.js";

// projectBlockcypherTx pure-function tests. We cover:
//   1. Single output paying our address → one DetectedTransfer
//   2. Output paying somebody else's address (change to sender) → ignored
//   3. Multi-output tx where multiple outputs pay us → multiple transfers
//   4. Mempool tx (block_height = -1) → blockNumber: null, confirmations: 0
//   5. Confirmed tx → carries block_height + confirmations through
//   6. Sender attribution from first input with a known address
//   7. Tx without `outputs` → empty array

const OUR_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const OTHER_ADDRESS = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";

const CTX = {
  chainId: 800 as ChainId,
  nativeSymbol: "BTC" as const,
  ourAddresses: new Set<string>([OUR_ADDRESS])
};

const SEEN = new Date("2026-04-26T12:00:00Z");

describe("projectBlockcypherTx", () => {
  it("emits one DetectedTransfer per output paying our address", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 1,
        addresses: [OUR_ADDRESS],
        inputs: [{ addresses: ["bc1qsender"] }],
        outputs: [{ value: 50_000, addresses: [OUR_ADDRESS] }]
      },
      CTX,
      SEEN
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      chainId: 800,
      txHash: "abc",
      logIndex: 0,
      fromAddress: "bc1qsender",
      toAddress: OUR_ADDRESS,
      token: "BTC",
      amountRaw: "50000",
      blockNumber: 100,
      confirmations: 1
    });
  });

  it("ignores outputs paying addresses we don't own (change to sender)", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 6,
        outputs: [
          { value: 50_000, addresses: [OUR_ADDRESS] },
          { value: 30_000, addresses: [OTHER_ADDRESS] }
        ]
      },
      CTX,
      SEEN
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.toAddress).toBe(OUR_ADDRESS);
  });

  it("emits multiple transfers when one tx pays our address twice (different vouts)", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 3,
        outputs: [
          { value: 25_000, addresses: [OUR_ADDRESS] },
          { value: 75_000, addresses: [OUR_ADDRESS] }
        ]
      },
      CTX,
      SEEN
    );
    expect(transfers).toHaveLength(2);
    expect(transfers.map((t) => t.logIndex).sort()).toEqual([0, 1]);
    expect(transfers.map((t) => t.amountRaw).sort()).toEqual(["25000", "75000"]);
  });

  it("represents mempool txs with blockNumber=null + confirmations=0", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: -1, // BlockCypher convention for mempool
        confirmations: 0,
        outputs: [{ value: 10_000, addresses: [OUR_ADDRESS] }]
      },
      CTX,
      SEEN
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.blockNumber).toBeNull();
    expect(transfers[0]?.confirmations).toBe(0);
  });

  it("uses the FIRST input with a known address as fromAddress (best-effort attribution)", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 1,
        inputs: [
          { addresses: [] }, // unidentified input
          { addresses: ["bc1qfirst"] },
          { addresses: ["bc1qsecond"] }
        ],
        outputs: [{ value: 1_000, addresses: [OUR_ADDRESS] }]
      },
      CTX,
      SEEN
    );
    expect(transfers[0]?.fromAddress).toBe("bc1qfirst");
  });

  it("returns empty array when no output pays an owned address (payout self-detect path)", () => {
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 1,
        inputs: [{ addresses: [OUR_ADDRESS] }], // we're the SENDER, not receiver
        outputs: [{ value: 10_000, addresses: [OTHER_ADDRESS] }]
      },
      CTX,
      SEEN
    );
    expect(transfers).toEqual([]);
  });

  it("handles missing outputs field gracefully (defensive against malformed payload)", () => {
    const transfers = projectBlockcypherTx(
      { hash: "abc", block_height: 100, confirmations: 1 },
      CTX,
      SEEN
    );
    expect(transfers).toEqual([]);
  });

  it("lowercases output addresses for case-insensitive ownership check", () => {
    // Addresses we own are stored lowercased; payloads from BlockCypher
    // sometimes return mixed case. The matcher must lowercase before
    // checking ownership.
    const upperPayload = OUR_ADDRESS.toUpperCase();
    const transfers = projectBlockcypherTx(
      {
        hash: "abc",
        block_height: 100,
        confirmations: 1,
        outputs: [{ value: 5_000, addresses: [upperPayload] }]
      },
      CTX,
      SEEN
    );
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.toAddress).toBe(OUR_ADDRESS); // lowercased
  });
});
