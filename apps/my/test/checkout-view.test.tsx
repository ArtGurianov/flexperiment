/** FLEX-122: the checkout view per phase (server-rendered markup; no browser). */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutView, type CheckoutActions } from "@/components/checkout/CheckoutView";
import type { CheckoutReview, CheckoutState } from "@/components/checkout/checkout-controller";

const noop: CheckoutActions = { confirm: () => {}, retry: () => {}, refreshStatus: () => {}, openPayment: () => {}, startOver: () => {} };
const html = (state: CheckoutState) => renderToStaticMarkup(<CheckoutView state={state} actions={noop} />);

const review = (kind: "COURSE" | "LAB"): CheckoutReview => ({
  quoteId: "q", kind, baseAmountKopecks: 990000, merchantDiscountKopecks: 100000, referralDiscountKopecks: 0, discountKopecks: 100000,
  finalAmountKopecks: 890000, expiresAt: "2026-11-22T12:15:00.000Z",
  occurrence: kind === "LAB" ? { title: "LAB · ноябрь", startsAt: "2026-11-28T16:00:00.000Z", timezone: "Europe/Moscow", venue: "Площадка, ул. Пример, 1" } : null, priceNotice: null,
  documents: [{ kind: "course_offer", url: "https://my.flexperiment.test/legal/x" }, { kind: "refund_terms", url: "https://my.flexperiment.test/legal/y" }],
  releaseVersion: "v", manifestSha256: "h", ...(kind === "COURSE" ? { receiptEmail: "buyer@example.test" } : {}),
});

describe("checkout view", () => {
  it("course review: final price, documents, one acceptance, submit disabled until accepted", () => {
    const markup = html({ phase: "REVIEW", review: review("COURSE"), busy: false });
    expect(markup).toContain("Итого к оплате");
    expect(markup).toMatch(/8\s?900/);
    expect(markup).toContain("Условия покупки (оферта)");
    expect(markup).toContain("Правила возврата");
    expect(markup).toContain("buyer@example.test");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(1);
    expect(markup).toMatch(/<button type="submit" disabled="">/);
    expect(markup).not.toMatch(/checked=""/);
  });

  it("LAB review: event details and three separate acceptances", () => {
    const markup = html({ phase: "REVIEW", review: review("LAB"), busy: false });
    expect(markup).toContain("Билет на событие");
    expect(markup).toContain("LAB · ноябрь");
    expect(markup).toContain("19:00"); // 16:00Z in the event's Europe/Moscow, not the browser zone
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
    expect(markup).toContain("персональных данных");
  });

  it("LAB closed sales and course closed sales read differently and offer no retry", () => {
    const labClosed = html({ phase: "UNAVAILABLE", code: "SALES_STOPPED", retryable: false, kind: "LAB" });
    expect(labClosed).toContain("Продажа билетов на события сейчас закрыта");
    expect(labClosed).not.toContain("Повторить");
    expect(html({ phase: "UNAVAILABLE", code: "PAYMENTS_DISABLED", retryable: false, kind: "COURSE" })).toContain("Продажи курса сейчас закрыты");
  });

  it.each([
    ["CONFIRMING", "Подтверждаем платёж"], ["AWAITING_PAYMENT", "ожидает завершения"], ["ACCESS_GRANTED", "Доступ к курсу открыт"],
    ["DECLINED", "Оформить заново"], ["EXPIRED", "Время оплаты истекло"], ["SUPPORT_REVIEW", "ord-1"],
  ] as const)("status %s", (payment, text) => {
    expect(html({ phase: "STATUS", kind: "COURSE", status: { orderPublicId: "ord-1", payment, ...(payment === "AWAITING_PAYMENT" ? { paymentUrl: "https://pay.test/s" } : {}) }, polling: false }))
      .toContain(text);
  });

  it("offers the exact lesson after Commerce confirms the purchase", () => {
    const lessonHref = "https://lms.fixture.test/courses/course/lessons/second";
    const show = (payment: "ACCESS_GRANTED" | "CONFIRMING") => renderToStaticMarkup(<CheckoutView
      state={{ phase: "STATUS", kind: "COURSE", status: { orderPublicId: "fixture", payment }, polling: false }}
      actions={noop} lessonHref={lessonHref} />);
    expect(show("ACCESS_GRANTED")).toContain(`href="${lessonHref}"`);
    expect(show("CONFIRMING")).not.toContain(lessonHref);
  });

  it("LAB ticket issued and declined (seat released)", () => {
    expect(html({ phase: "STATUS", kind: "LAB", status: { orderPublicId: "o", payment: "TICKET_ISSUED" }, polling: false })).toContain("Билет выпущен");
    expect(html({ phase: "STATUS", kind: "LAB", status: { orderPublicId: "o", payment: "DECLINED" }, polling: false })).toContain("Место освобождено");
  });

  it("sign-in, account confirmation, foreign order and offer mismatch", () => {
    expect(html({ phase: "SIGN_IN", href: "/sign-in?next=%2Fcheckout%2Fx" })).toContain('href="/sign-in?next=%2Fcheckout%2Fx"');
    expect(html({ phase: "ACCOUNT_CONFIRMATION", href: "/sign-in" })).toContain("подтверждённого аккаунта");
    expect(html({ phase: "ORDER_NOT_FOUND" })).toContain("не принадлежит вашему аккаунту");
    expect(html({ phase: "OFFER_MISMATCH" })).toContain("Мы ничего не оформили");
  });
});
