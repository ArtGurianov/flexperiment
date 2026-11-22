/** FLEX-122: controlled LMS and LAB checkout scenarios against a scripted Commerce (fixtures only). */
import { describe, expect, it } from "vitest";
import { validMyReturnTarget } from "@/lib/return-targets";
import { FakeCommerce, fixtures, MemoryStorage, ok, phases, setup } from "./checkout-harness";

const PREVIEW = "POST /v1/checkout/preview";
const CONFIRM = "POST /v1/checkout";
const status = (order: string) => `GET /v1/checkout/${order}`;
const lms = fixtures.lms;
const lab = fixtures.lab;
const r = fixtures.refusals;

describe("LMS (course) checkout", () => {
  it("anonymous buyer: sign-in with a valid my return target; nothing created", async () => {
    const t = setup(lms.offerRef, { commerce: new FakeCommerce().on(PREVIEW, r.signIn) });
    await t.controller.start();
    const state = t.controller.current;
    expect(state.phase).toBe("SIGN_IN");
    const next = decodeURIComponent((state as { href: string }).href.split("next=")[1]);
    expect(validMyReturnTarget(next)).toBe(`/checkout/${t.intentId}`);
    expect(t.commerce.count(CONFIRM)).toBe(0);
  });

  it("an LMS-audience session is refused like no session (Commerce SESSION_AUDIENCE_FORBIDDEN)", async () => {
    const t = setup(lms.offerRef, { commerce: new FakeCommerce().on(PREVIEW, r.audience) });
    await t.controller.start();
    expect(t.controller.current.phase).toBe("SIGN_IN");
  });

  it("review shows the server price and documents; only explicit acceptance confirms; provider return reads status", async () => {
    const storage = new MemoryStorage();
    const commerce = new FakeCommerce().on(PREVIEW, ok(lms.preview)).on(CONFIRM, ok(lms.confirm, 201));
    const t = setup(lms.offerRef, { storage, commerce });
    await t.controller.start();
    const review = t.controller.current;
    if (review.phase !== "REVIEW") throw new Error(review.phase);
    expect(review.review.finalAmountKopecks).toBe(890000);
    expect(review.review.priceNotice?.code).toBe("PRICE_CHANGED_SINCE_DISPLAY");
    expect(review.review.documents.map((d) => d.kind)).toEqual(["course_offer", "refund_terms", "personal_data"]); // javascript: dropped
    expect(commerce.calls[0].body).toEqual({ offerRef: "course:one" }); // no type, price or storefront from the URL

    await t.controller.confirm({ termsAccepted: false });
    expect(commerce.count(CONFIRM)).toBe(0);

    await t.controller.confirm({ termsAccepted: true });
    const sent = commerce.calls.find((c) => c.method === "POST" && c.path === "/v1/checkout")!;
    expect(sent.body).toEqual({ quoteId: "quote-course-0001", returnPath: `/checkout/${t.intentId}`, legalAcceptance: {
      accepted: true, releaseVersion: "courses-2026-11-b1", manifestSha256: "1".repeat(64), receiptEmail: "buyer@example.test" } });
    expect(sent.headers["idempotency-key"]).toBe("payment-key-2");
    expect(t.navigations).toEqual(["https://pay.fake-provider.test/session/ord-course-0001"]);
    expect([...storage.data.values()].join("")).not.toContain("@");

    // Provider return in a fresh page: the redirect proves nothing; only the status read does.
    const back = setup(lms.offerRef, { storage, returnedOrder: "ord-course-0001",
      commerce: new FakeCommerce().on(status("ord-course-0001"), ...lms.statusSequence.map((body) => ok(body))) });
    await back.controller.start();
    expect(back.states.filter((s) => s.phase === "STATUS").map((s) => s.phase === "STATUS" && s.status.payment))
      .toEqual(["CONFIRMING", "ACCESS_GRANTED"]);
    expect(back.commerce.count(PREVIEW) + back.commerce.count(CONFIRM)).toBe(0);
  });

  it("double click sends one confirm", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, ok(lms.preview)).on(CONFIRM, ok(lms.confirm, 201));
    const t = setup(lms.offerRef, { commerce });
    await t.controller.start();
    await Promise.all([t.controller.confirm({ termsAccepted: true }), t.controller.confirm({ termsAccepted: true })]);
    expect(commerce.count(CONFIRM)).toBe(1);
  });

  it("lost confirm answer: retry resends the same key and body; refresh resends the same key", async () => {
    const storage = new MemoryStorage();
    const commerce = new FakeCommerce().on(PREVIEW, ok(lms.preview))
      .on(CONFIRM, { status: 0, body: {} }, r.unknownOutcome, ok(lms.confirm, 201));
    const t = setup(lms.offerRef, { storage, commerce });
    await t.controller.start();
    await t.controller.confirm({ termsAccepted: true });
    expect(t.controller.current).toMatchObject({ phase: "UNAVAILABLE", code: "CONFIRM_OUTCOME_UNKNOWN", retryable: true });
    await t.controller.retry();
    const confirms = commerce.calls.filter((c) => c.path === "/v1/checkout");
    expect(confirms).toHaveLength(2);
    expect(confirms[1].headers["idempotency-key"]).toBe(confirms[0].headers["idempotency-key"]);
    expect(confirms[1].body).toEqual(confirms[0].body);

    // Refresh: the acceptance is not persisted; the same key is resent and Commerce answers with its order.
    const refreshed = setup(lms.offerRef, { storage, commerce });
    await refreshed.controller.start();
    const third = commerce.calls.filter((c) => c.path === "/v1/checkout")[2];
    expect(third.headers["idempotency-key"]).toBe(confirms[0].headers["idempotency-key"]);
    expect(third.body).toEqual({ quoteId: "quote-course-0001", returnPath: `/checkout/${t.intentId}` });
    expect(refreshed.navigations).toEqual(["https://pay.fake-provider.test/session/ord-course-0001"]);
  });

  it("refresh after a confirm that never arrived: the same quote is shown again for explicit acceptance", async () => {
    const storage = new MemoryStorage();
    const first = setup(lms.offerRef, { storage, commerce: new FakeCommerce().on(PREVIEW, ok(lms.preview)).on(CONFIRM, { status: 0, body: {} }) });
    await first.controller.start();
    await first.controller.confirm({ termsAccepted: true });
    const commerce = new FakeCommerce().on(CONFIRM, r.unknownOutcome, ok(lms.confirm, 201)).on(PREVIEW, ok(lms.preview));
    const again = setup(lms.offerRef, { storage, commerce });
    await again.controller.start();
    expect(again.controller.current).toMatchObject({ phase: "REVIEW", notice: "CONFIRM_AGAIN" });
    expect(commerce.calls.find((c) => c.path === "/v1/checkout/preview")!.headers["idempotency-key"]).toBe("preview-key-1");
    await again.controller.confirm({ termsAccepted: true });
    const confirms = commerce.calls.filter((c) => c.path === "/v1/checkout");
    expect(confirms[1].headers["idempotency-key"]).toBe(confirms[0].headers["idempotency-key"]);
  });

  it("expired quote: a new preview under a new key, buyer told the price is re-checked", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, ok(lms.preview)).on(CONFIRM, r.quoteExpired);
    const t = setup(lms.offerRef, { commerce });
    await t.controller.start();
    await t.controller.confirm({ termsAccepted: true });
    const previews = commerce.calls.filter((c) => c.path === "/v1/checkout/preview");
    expect(previews).toHaveLength(2);
    expect(previews[1].headers["idempotency-key"]).not.toBe(previews[0].headers["idempotency-key"]);
    expect(t.controller.current).toMatchObject({ phase: "REVIEW", notice: "QUOTE_RENEWED" });
  });

  it("payment already in progress on another order of this account: that order is read, none started", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, r.paymentInProgress)
      .on(status("ord-course-0000"), ok({ orderPublicId: "ord-course-0000", state: "PAID" }));
    const t = setup(lms.offerRef, { commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "STATUS", status: { orderPublicId: "ord-course-0000", payment: "ACCESS_GRANTED" } });
    expect(commerce.count(CONFIRM)).toBe(0);
  });

  it("foreign order in ?order=: 404 → not found; stored progress is not replaced by it", async () => {
    const storage = new MemoryStorage();
    const t0 = setup(lms.offerRef, { storage, commerce: new FakeCommerce().on(PREVIEW, ok(lms.preview)) });
    await t0.controller.start();
    const before = [...storage.data.values()][0];
    const t = setup(lms.offerRef, { storage, returnedOrder: "ord-of-someone-else", commerce: new FakeCommerce().on(status("ord-of-someone-else"), r.foreignOrder) });
    await t.controller.start();
    expect(t.controller.current.phase).toBe("ORDER_NOT_FOUND");
    expect([...storage.data.values()][0]).toBe(before);
  });

  it("offer substitution: an answer for another offer is refused and nothing is confirmed", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, ok({ ...lms.preview, offerRef: "course:two" }));
    const t = setup(lms.offerRef, { commerce });
    await t.controller.start();
    expect(t.controller.current.phase).toBe("OFFER_MISMATCH");
    expect(t.storage.data.size).toBe(0);
    await t.controller.confirm({ termsAccepted: true });
    expect(commerce.count(CONFIRM)).toBe(0);
  });

  it("no documents → no acceptance possible (fails closed)", async () => {
    const { legalAcceptance: _omit, ...withoutLegal } = lms.preview;
    void _omit;
    const t = setup(lms.offerRef, { commerce: new FakeCommerce().on(PREVIEW, ok(withoutLegal)) });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "UNAVAILABLE", code: "LEGAL_REVIEW_UNAVAILABLE" });
  });

  it("late status answer is dropped; terminal state stays", async () => {
    let releaseSlow!: () => void;
    const slow = () => new Promise<{ status: number; body: unknown }>((resolve) => {
      releaseSlow = () => resolve(ok({ orderPublicId: "ord-course-0001", state: "CREATE_UNKNOWN" }));
    });
    const commerce = new FakeCommerce().on(status("ord-course-0001"), slow, ok({ orderPublicId: "ord-course-0001", payment: "ACCESS_GRANTED" }));
    const t = setup(lms.offerRef, { returnedOrder: "ord-course-0001", commerce });
    const older = t.controller.readStatus("ord-course-0001", false);
    await t.controller.readStatus("ord-course-0001", false);
    releaseSlow();
    await older;
    expect(t.controller.current).toMatchObject({ phase: "STATUS", status: { payment: "ACCESS_GRANTED" } });
  });

  it("status read times out: last status kept, buyer told it is being checked, no repeat payment", async () => {
    const commerce = new FakeCommerce().on(status("ord-course-0001"), { status: 503, body: { code: "RECONCILE_FAILED" } });
    const t = setup(lms.offerRef, { returnedOrder: "ord-course-0001", commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "STATUS", polling: false, notice: "STATUS_DELAYED", status: { payment: "CONFIRMING" } });
    expect(commerce.count(CONFIRM)).toBe(0);
  });
});

describe("LAB checkout", () => {
  it("unconfirmed account: LAB_ACCOUNT_CONFIRMATION_REQUIRED → confirm via sign-in, no order", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, lab.refusals.accountConfirmation);
    const t = setup(lab.offerRef, { commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "ACCOUNT_CONFIRMATION" });
    expect(commerce.count(CONFIRM)).toBe(0);
  });

  it("LAB sales closed: shown as closed, no order and no seat", async () => {
    const commerce = new FakeCommerce().on(PREVIEW, lab.refusals.salesClosed);
    const t = setup(lab.offerRef, { commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "UNAVAILABLE", code: "SALES_STOPPED", kind: "LAB", retryable: false });
  });

  it("three explicit LAB acceptances, provider page, ticket only after authoritative status", async () => {
    const storage = new MemoryStorage();
    const commerce = new FakeCommerce().on(PREVIEW, ok(lab.preview)).on(CONFIRM, ok(lab.confirm, 201));
    const t = setup(lab.offerRef, { storage, commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "REVIEW", review: { kind: "LAB", finalAmountKopecks: 250000 } });
    await t.controller.confirm({ termsAccepted: true, personalDataConsent: true, receiptContactAccepted: false });
    expect(commerce.count(CONFIRM)).toBe(0);
    await t.controller.confirm({ termsAccepted: true, personalDataConsent: true, receiptContactAccepted: true });
    expect(commerce.calls.find((c) => c.path === "/v1/checkout")!.body).toEqual({ quoteId: "quote-lab-0001", returnPath: `/checkout/${t.intentId}`,
      labAcceptance: { personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true,
        releaseVersion: "lab-2026-11-b1", manifestSha256: "2".repeat(64) } });
    expect(t.navigations).toEqual(["https://pay.fake-provider.test/session/ord-lab-0001"]);

    const back = setup(lab.offerRef, { storage, returnedOrder: "ord-lab-0001",
      commerce: new FakeCommerce().on(status("ord-lab-0001"), ...lab.statusSequence.map((body) => ok(body))) });
    await back.controller.start();
    expect(back.controller.current).toMatchObject({ phase: "STATUS", kind: "LAB", status: { payment: "TICKET_ISSUED" } });
  });

  it("refresh after the return keeps the order (stored once Commerce answered for it)", async () => {
    const storage = new MemoryStorage();
    const commerce = new FakeCommerce().on(status("ord-lab-0001"), ok({ orderPublicId: "ord-lab-0001", payment: "TICKET_ISSUED" }));
    await setup(lab.offerRef, { storage, returnedOrder: "ord-lab-0001", commerce }).controller.start();
    const refreshed = setup(lab.offerRef, { storage, commerce });
    await refreshed.controller.start();
    expect(refreshed.controller.current).toMatchObject({ phase: "STATUS", status: { orderPublicId: "ord-lab-0001", payment: "TICKET_ISSUED" } });
    expect(commerce.count(PREVIEW)).toBe(0);
  });

  it("declined: never a second payment on the order; starting over is a new preview and order", async () => {
    const storage = new MemoryStorage();
    const commerce = new FakeCommerce().on(status("ord-lab-0001"), ok({ orderPublicId: "ord-lab-0001", payment: "DECLINED" }))
      .on(PREVIEW, ok(lab.preview));
    const t = setup(lab.offerRef, { storage, returnedOrder: "ord-lab-0001", commerce });
    await t.controller.start();
    expect(t.controller.current).toMatchObject({ phase: "STATUS", status: { payment: "DECLINED" } });
    await t.controller.startOver();
    expect(t.controller.current.phase).toBe("REVIEW");
    expect(commerce.count(CONFIRM)).toBe(0);
    expect(JSON.parse([...storage.data.values()][0]).orderPublicId).toBeUndefined();
  });

  it("a course answer for a LAB intent (type/offer substitution) is refused", async () => {
    const t = setup(lab.offerRef, { commerce: new FakeCommerce().on(PREVIEW, ok({ ...lms.preview, offerRef: undefined })) });
    await t.controller.start();
    expect(t.controller.current.phase).toBe("OFFER_MISMATCH");
  });

  it("support review shows the support reference", async () => {
    const commerce = new FakeCommerce().on(status("ord-lab-0001"), ok({ orderPublicId: "ord-lab-0001", payment: "SUPPORT_REVIEW", supportReference: "SUP-7788" }));
    const t = setup(lab.offerRef, { returnedOrder: "ord-lab-0001", commerce });
    await t.controller.start();
    expect(phases(t.states)).toEqual(["STATUS"]);
    expect(t.controller.current).toMatchObject({ status: { supportReference: "SUP-7788" } });
  });
});
