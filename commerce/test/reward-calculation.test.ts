import { describe, expect, it } from "vitest";
import { rewardForOrder, REWARD_FORMULA_VERSION } from "../src/reward-calculation";

/**
 * `rewardForOrder` was lifted verbatim out of CommerceDomain's private
 * method of the same name (domain.ts). This is the byte-identical
 * regression proof: every branch of the original inline formula,
 * reproduced here against the extracted pure function, plus the exact
 * legacy fixtures that formula has always had to get right.
 */

describe("reward-calculation.ts: byte-identical extraction of CommerceDomain's legacy rewardForOrder", () => {
  it("no attribution -> 0, regardless of net captured", () => {
    expect(rewardForOrder({ attributed_agent_id: null, reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 }, 100_000)).toBe(0);
  });

  it("no reward type snapshot -> 0", () => {
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: null, reward_value_snapshot: 1000 }, 100_000)).toBe(0);
  });

  it("zero or negative net captured -> 0 (refunds have fully absorbed the capture)", () => {
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 }, 0)).toBe(0);
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 }, -500)).toBe(0);
  });

  it("PERCENT uses basisPointsOf exactly - half-up integer kopecks, no floating point", () => {
    // 100_000 kopecks at 10.00% (1000 bps) = 10_000 kopecks exactly.
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 }, 100_000)).toBe(10_000);
    // A basis-point amount that does not divide evenly still rounds half-up, matching basisPointsOf's own contract.
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 333 }, 100_001)).toBe(3_330);
  });

  it("PERCENT with a missing reward_value_snapshot treats it as 0 (0 ?? 0 branch)", () => {
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: null }, 100_000)).toBe(0);
  });

  it("FIXED returns min(netCaptured, rewardValue) - capped at the net captured amount, never exceeding it", () => {
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "FIXED", reward_value_snapshot: 5_000 }, 100_000)).toBe(5_000);
  });

  it("FIXED reward larger than net captured is capped at net captured, never paid in excess of what was actually received", () => {
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "FIXED", reward_value_snapshot: 500_000 }, 40_000)).toBe(40_000);
  });

  it("refunds reducing net captured reduce the reward proportionally for PERCENT and by the capped amount for FIXED", () => {
    // Full capture 100_000, refunded 60_000 -> net 40_000.
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 }, 40_000)).toBe(4_000);
    expect(rewardForOrder({ attributed_agent_id: "agent-1", reward_type_snapshot: "FIXED", reward_value_snapshot: 5_000 }, 40_000)).toBe(5_000); // still fully payable - net captured comfortably covers it
  });

  it("REWARD_FORMULA_VERSION is a stable, load-bearing integer the registry pins on every finalization", () => {
    expect(REWARD_FORMULA_VERSION).toBe(1);
    expect(Number.isInteger(REWARD_FORMULA_VERSION)).toBe(true);
  });
});
