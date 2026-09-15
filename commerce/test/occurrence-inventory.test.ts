import { describe, expect, it } from "vitest";
import { assertInventoryTarget, InventoryTargetError, occurrenceInventory, resolveInventoryTarget } from "../src/occurrence-inventory";
import { availabilityStatus } from "../src/purchase-status";

const commitments = { sold: 8, held: 2, reconciling: 1 };

describe("occurrence inventory targets", () => {
  it("uses the complete target, not an intermediate capacity value", () => {
    const target = resolveInventoryTarget({ capacity: 30, admin_reserved_seats: 8 }, { capacity: 20, admin_reserved_seats: 5 });
    expect(() => assertInventoryTarget({ sold: 15, held: 0, reconciling: 0 }, target)).not.toThrow();
  });

  it("reports the precedence and an operator-safe breakdown", () => {
    expect(() => assertInventoryTarget(commitments, { capacity: 10, adminReservedSeats: 0 })).toThrow("CAPACITY_BELOW_COMMITTED_SEATS");
    expect(() => assertInventoryTarget(commitments, { capacity: 12, adminReservedSeats: 3 })).toThrow("RESERVE_EXCEEDS_AVAILABLE_CAPACITY");
  });

  it("reports the resulting-state minimum even when committed customers choose the error code", () => {
    try {
      assertInventoryTarget({ sold: 8, held: 2, reconciling: 1 }, { capacity: 10, adminReservedSeats: 3 });
      throw new Error("expected target validation to reject the shrink");
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryTargetError);
      expect(error).toMatchObject({
        code: "CAPACITY_BELOW_COMMITTED_SEATS",
        details: { requested_capacity: 10, minimum_capacity: 14, breakdown: { sold: 8, held: 2, reconciling: 1, admin_reserved: 3 } },
      });
    }
  });

  it("keeps negative availability diagnostic rather than clamping it", () => {
    const db = { prepare: () => ({ get: () => ({ sold: 12, reserved: 0, reconciling: 0 }) }) } as never;
    expect(occurrenceInventory(db, { id: "occurrence", capacity: 10, admin_reserved_seats: 0 }).available).toBe(-2);
  });

  it("bands public availability at zero, five and six", () => {
    expect([availabilityStatus(0), availabilityStatus(5), availabilityStatus(6)]).toEqual(["SOLD_OUT", "FEW_LEFT", "AVAILABLE"]);
  });
});
