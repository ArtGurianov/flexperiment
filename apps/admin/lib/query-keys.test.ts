import { describe, expect, it } from "vitest";
import { dashboardKeys, incidentKeys, occurrenceKeys, orderKeys, refundKeys, settlementKeys } from "./query-keys";

describe("query key taxonomy", () => {
  it("gives every list() key the lists() prefix", () => {
    expect(orderKeys.list({ city_id: "moscow" }).slice(0, 2)).toEqual(orderKeys.lists());
    expect(refundKeys.list({ source: "ADMIN_COMPENSATION" }).slice(0, 2)).toEqual(refundKeys.lists());
  });

  it("keeps lists() a strict prefix of all(), not equal to it", () => {
    expect(orderKeys.lists()).not.toEqual(orderKeys.all());
    expect(orderKeys.lists().slice(0, 1)).toEqual(orderKeys.all());
  });

  it("produces identical keys for logically-equal filters regardless of extra empty fields", () => {
    expect(orderKeys.list({ city_id: "moscow" })).toEqual(orderKeys.list({ city_id: "moscow", payment_status: "" }));
  });

  it("keeps evidence and detail keys outside the lists() prefix so list invalidation cannot nuke open panels", () => {
    const evidence = orderKeys.evidence("order-1");
    expect(evidence.slice(0, 2)).not.toEqual(orderKeys.lists());
    const financials = occurrenceKeys.cancellationFinancials("occ-1");
    expect(financials.slice(0, 2)).not.toEqual(occurrenceKeys.lists());
  });

  it("scopes settlement detail keys to a specific id", () => {
    expect(settlementKeys.detail("a")).not.toEqual(settlementKeys.detail("b"));
  });

  it("keeps filtered settlement and incident lists in distinct cache leaves", () => {
    expect(settlementKeys.list()).not.toEqual(settlementKeys.list({ stale_prepared: true }));
    expect(incidentKeys.list()).not.toEqual(incidentKeys.list({ status: "OPEN" }));
  });

  it("gives the dashboard summary its own stable key", () => {
    expect(dashboardKeys.summary()).toEqual(["dashboard", "summary"]);
  });
});
