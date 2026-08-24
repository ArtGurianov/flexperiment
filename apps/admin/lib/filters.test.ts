import { describe, expect, it } from "vitest";
import {
  normalizeOrderFilters, normalizeRefundFilters,
  incidentFiltersFromSearchParams, incidentFiltersToSearch, normalizeIncidentFilters,
  orderFiltersFromSearchParams, orderFiltersToSearch,
  refundFiltersFromSearchParams, refundFiltersToSearch, settlementFiltersFromSearchParams,
  settlementFiltersToSearch,
} from "./filters";

describe("order filter normalization", () => {
  it("treats {}, empty strings, and undefined as one logical query", () => {
    const empty = normalizeOrderFilters({});
    const blank = normalizeOrderFilters({ city_id: "", occurrence_id: undefined });
    const explicit = normalizeOrderFilters({ city_id: undefined });
    expect(empty).toEqual({});
    expect(blank).toEqual({});
    expect(explicit).toEqual({});
  });

  it("keeps only truthy filter values", () => {
    expect(normalizeOrderFilters({ city_id: "moscow", payment_status: "", booking_status: "CONFIRMED" }))
      .toEqual({ city_id: "moscow", booking_status: "CONFIRMED" });
  });

  it("round-trips through URL search params without drift", () => {
    const filters = { city_id: "moscow", payment_state: "REVIEW_REQUIRED" };
    const search = orderFiltersToSearch(filters);
    const restored = orderFiltersFromSearchParams(new URLSearchParams(search));
    expect(restored).toEqual(normalizeOrderFilters(filters));
  });

  it("serializes an empty filter set to an empty string", () => {
    expect(orderFiltersToSearch({ city_id: "" })).toBe("");
  });
});

describe("dashboard destination filter normalization", () => {
  it("makes stale-prepared settlement filtering one stable API/cache contract", () => {
    expect(settlementFiltersFromSearchParams(new URLSearchParams("stale_prepared=1"))).toEqual({ stale_prepared: true });
    expect(settlementFiltersToSearch({ stale_prepared: true })).toBe("stale_prepared=1");
  });

  it("admits only authoritative incident status predicates", () => {
    expect(incidentFiltersFromSearchParams(new URLSearchParams("status=OPEN"))).toEqual({ status: "OPEN" });
    expect(incidentFiltersFromSearchParams(new URLSearchParams("status=UNKNOWN"))).toEqual({});
    expect(normalizeIncidentFilters({ status: "RESOLVED" })).toEqual({ status: "RESOLVED" });
    expect(incidentFiltersToSearch({ status: "OPEN" })).toBe("status=OPEN");
  });
});

describe("refund filter normalization", () => {
  it("sorts multi-value status for stable cache identity regardless of insertion order", () => {
    const left = normalizeRefundFilters({ status: ["SUBMITTING", "REQUESTED"] });
    const right = normalizeRefundFilters({ status: ["REQUESTED", "SUBMITTING"] });
    expect(left).toEqual(right);
  });

  it("round-trips repeated status params through the URL", () => {
    const filters = { status: ["REQUESTED", "SUBMITTING", "SUBMIT_UNKNOWN", "RECONCILING"], source: "ADMIN_COMPENSATION" };
    const search = refundFiltersToSearch(filters);
    const restored = refundFiltersFromSearchParams(new URLSearchParams(search));
    expect(restored).toEqual(normalizeRefundFilters(filters));
  });

  it("drops an empty status array", () => {
    expect(normalizeRefundFilters({ status: [] })).toEqual({});
  });
});
