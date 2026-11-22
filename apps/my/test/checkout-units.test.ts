/** FLEX-122: intent codec, intent storage and the buyer-status projection (contract C §8). */
import { describe, expect, it } from "vitest";
import { acceptStatus, normalizeStatus, projectPaymentState, projectRefundState, safePaymentUrl } from "@/components/checkout/buyer-status";
import { decodeIntentId, encodeIntentId, INTENT_ID, kindHint } from "@/components/checkout/intent";
import { IntentStore } from "@/components/checkout/intent-store";
import { validMyReturnTarget } from "@/lib/return-targets";
import buyerStates from "./fixtures/checkout/buyer-states.c-34131eb9.json";
import { MemoryStorage, MY } from "./checkout-harness";

describe("intent id", () => {
  it.each(["course:one", "course:test-course", "lab:november", "lab:2026-11-01", "bundle:all-courses"])("round-trips %s and fits B §7", (offerRef) => {
    const id = encodeIntentId(offerRef)!;
    expect(id).toMatch(INTENT_ID);
    expect(decodeIntentId(id)).toBe(offerRef);
    expect(validMyReturnTarget(`/checkout/${id}`)).toBe(`/checkout/${id}`);
  });

  it("refuses malformed, foreign-prefix, non-canonical and over-long ids", () => {
    expect(decodeIntentId("offer")).toBeNull();
    expect(decodeIntentId("notofferY291cnNlOm9uZQ")).toBeNull();
    expect(decodeIntentId("offer" + Buffer.from("evil:thing").toString("base64url"))).toBeNull();
    expect(decodeIntentId("offer" + Buffer.from("course:one").toString("base64url") + "A")).toBeNull();
    expect(decodeIntentId("../../etc/passwd")).toBeNull();
    expect(encodeIntentId("lab:" + "x".repeat(60))).toBeNull();
    expect(encodeIntentId("course:Bad Ref")).toBeNull();
  });

  it("treats ?type= as a hint only", () => {
    expect(kindHint("lab")).toBe("LAB");
    expect(kindHint("course")).toBe("COURSE");
    expect(kindHint("LAB<script>")).toBeNull();
  });
});

describe("intent storage", () => {
  it("persists only keys and ids — no e-mail, acceptance or amount", () => {
    const storage = new MemoryStorage();
    const store = new IntentStore(storage, "offerY291cnNlOm9uZQ", "course:one", () => "k1");
    store.load();
    store.update({ quoteId: "q1", kind: "COURSE", paymentKey: "p1", orderPublicId: "o1",
      ...({ receiptEmail: "buyer@example.test", finalAmountKopecks: 1, confirmBody: { legalAcceptance: {} } } as object) });
    const raw = [...storage.data.values()].join("");
    expect(JSON.parse(raw)).toEqual({ v: 1, offerRef: "course:one", previewKey: "k1", quoteId: "q1", kind: "COURSE", paymentKey: "p1", orderPublicId: "o1" });
    expect(raw).not.toMatch(/@|Kopecks|Acceptance|confirmBody/);
  });

  it("discards a record for another offer or with foreign fields", () => {
    const storage = new MemoryStorage();
    storage.setItem("flx-checkout:id-1", JSON.stringify({ v: 1, offerRef: "course:two", previewKey: "old", quoteId: "q" }));
    expect(new IntentStore(storage, "id-1", "course:one", () => "fresh").load()).toEqual({ v: 1, offerRef: "course:one", previewKey: "fresh" });
    storage.setItem("flx-checkout:id-2", JSON.stringify({ v: 1, offerRef: "course:one", previewKey: "old", receiptEmail: "x@y" }));
    expect(new IntentStore(storage, "id-2", "course:one", () => "fresh").load().previewKey).toBe("fresh");
  });

  it("survives blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(new IntentStore(blocked, "id", "course:one", () => "k").load().previewKey).toBe("k");
  });
});

describe("buyer status projection (C §8, buyer-states.json @34131eb9)", () => {
  it.each(buyerStates.payment)("payment $state ($kind) → $expect", ({ state, kind, expect: expected }) => {
    expect(projectPaymentState(state, kind === "LAB" ? "LAB" : "COURSE")).toBe(expected);
  });
  it.each(buyerStates.refund)("refund $state → $expect", ({ state, expect: expected }) => {
    expect(projectRefundState(state)).toBe(expected);
  });

  it("never reads payment from an unknown or missing state", () => {
    expect(projectPaymentState("SUCCESS", "COURSE")).toBe("CONFIRMING");
    expect(normalizeStatus({}, "o1", "COURSE", MY)?.payment).toBe("CONFIRMING");
  });

  it("accepts both the current reconcile answer and the proposed DTO", () => {
    expect(normalizeStatus({ orderPublicId: "o1", state: "PENDING", checkoutUrl: "https://pay.test/s" }, "o1", "LAB", MY))
      .toEqual({ orderPublicId: "o1", payment: "AWAITING_PAYMENT", paymentUrl: "https://pay.test/s" });
    expect(normalizeStatus({ orderPublicId: "o1", payment: "SUPPORT_REVIEW", supportReference: "SUP-1234" }, "o1", "LAB", MY))
      .toEqual({ orderPublicId: "o1", payment: "SUPPORT_REVIEW", supportReference: "SUP-1234" });
    expect(normalizeStatus({ orderPublicId: "o1", state: "REFUNDED" }, "o1", "COURSE", MY))
      .toEqual({ orderPublicId: "o1", payment: "ACCESS_GRANTED", refund: "REFUNDED" });
  });

  it("drops an answer about another order and unsafe payment URLs", () => {
    expect(normalizeStatus({ orderPublicId: "other", payment: "ACCESS_GRANTED" }, "o1", "COURSE", MY)).toBeNull();
    expect(safePaymentUrl("javascript:alert(1)", MY)).toBeUndefined();
    expect(safePaymentUrl("http://pay.test/s", MY)).toBeUndefined();
    expect(safePaymentUrl("/legal/x", MY)).toBe(`${MY}/legal/x`);
  });

  it("drops late answers and never regresses a terminal state", () => {
    const paid = { orderPublicId: "o1", payment: "ACCESS_GRANTED" as const };
    const pending = { orderPublicId: "o1", payment: "CONFIRMING" as const };
    const applied = acceptStatus(null, 2, paid);
    expect(acceptStatus(applied, 1, pending)).toBe(applied);
    expect(acceptStatus(applied, 3, pending).status.payment).toBe("ACCESS_GRANTED");
    expect(acceptStatus(applied, 4, { orderPublicId: "o1", payment: "SUPPORT_REVIEW" }).status.payment).toBe("SUPPORT_REVIEW");
    expect(acceptStatus(applied, 5, { orderPublicId: "o1", payment: "DECLINED" }).status.payment).toBe("ACCESS_GRANTED");
  });
});
