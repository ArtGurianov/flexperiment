import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "./latest-request";

describe("latest request gate", () => {
  it("rejects an initial stale read after a mutation-triggered refresh", () => {
    const gate = createLatestRequestGate();
    const initialRead = gate.begin();
    const mutationRefresh = gate.begin();
    expect(gate.isLatest(initialRead)).toBe(false);
    expect(gate.isLatest(mutationRefresh)).toBe(true);
  });

  it("rejects completions after unmount invalidation", () => {
    const gate = createLatestRequestGate();
    const read = gate.begin();
    gate.invalidate();
    expect(gate.isLatest(read)).toBe(false);
  });
});
