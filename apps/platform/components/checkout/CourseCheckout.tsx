"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { checkoutCodeMessage, type CheckoutCodeOutcome } from "./checkout-copy";

type Props = {
  courseRef: string;
  offerRef: string | null;
  saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  priceKopecks: number | null;
};

type CheckoutResult = { orderPublicId?: string; state?: string; checkoutUrl?: string; code?: string };
type CheckoutQuote = {
  quoteId: string;
  state: "PRICE_REVIEW_REQUIRED";
  baseAmountKopecks: number;
  merchantDiscountKopecks: number;
  referralDiscountKopecks: number;
  discountKopecks: number;
  finalAmountKopecks: number;
  merchantPromotionCode: string | null;
  checkoutCodeOutcome: CheckoutCodeOutcome;
  expiresAt: string;
  /** The quote keeps its price; this only says the buyer saw, or the catalogue now shows, another one. */
  priceNotice?: null
    | { code: "CATALOG_PRICE_CHANGED_AFTER_QUOTE"; quotedAmountKopecks: number; currentAmountKopecks: number }
    | { code: "PRICE_CHANGED_SINCE_DISPLAY"; quotedAmountKopecks: number; displayedAmountKopecks: number };
  legalAcceptance?: { releaseVersion: string; manifestSha256: string; receiptEmail: string;
    documents: Array<{ kind: string; version: string; sha256: string; url: string }> };
};
const documentLabels: Record<string, string> = { course_offer: "Условия покупки", refund_terms: "Правила возврата",
  receipt_contact: "Данные для чека", fiscal_items: "Фискальные сведения", privacy: "Политика данных",
  personal_data: "Согласие на обработку данных", account_terms: "Правила аккаунта", marketing_consent: "Рекламный выбор" };

const price = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(kopecks / 100);

const observeCheckout = async (initial: CheckoutResult): Promise<CheckoutResult> => {
  let result = initial;
  for (let attempt = 0; result.orderPublicId && ["CREATE_UNKNOWN", "PENDING"].includes(result.state ?? "") && attempt < 15; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    const response = await fetch(`/v1/checkout/${encodeURIComponent(result.orderPublicId)}`, { cache: "no-store", credentials: "same-origin" });
    result = await response.json() as CheckoutResult;
    if (!response.ok) throw new Error(result.code || "CHECKOUT_RECONCILE_FAILED");
  }
  return result;
};

export default function CourseCheckout({ courseRef, offerRef, saleMode, priceKopecks }: Props) {
  const pathname = usePathname();
  const [session, setSession] = useState<"loading" | "anonymous" | "signed-in" | "owned">("loading");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [consentRequired, setConsentRequired] = useState(false);
  const [checkoutCode, setCheckoutCode] = useState("");
  const previewIdempotencyKey = useRef<string | null>(null);
  const paymentIdempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    void fetch("/v1/me", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.json())
      .then((body: { customer?: unknown; entitlements?: Array<{ scope: string; course_ref?: string | null }> }) => {
        if (!body.customer) { setSession("anonymous"); return; }
        const owned = (body.entitlements ?? []).some((grant) => grant.scope === "ALL_COURSES" || (grant.scope === "COURSE" && grant.course_ref === courseRef));
        setSession(owned ? "owned" : "signed-in");
      })
      .catch(() => setSession("anonymous"));
  }, [courseRef]);

  useEffect(() => {
    const orderPublicId = new URLSearchParams(window.location.search).get("order");
    if (!orderPublicId) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setBusy(true);
      setStatus("Проверяем оплату…");
    });
    void observeCheckout({ orderPublicId, state: "PENDING" })
      .then((result) => {
        if (!active) return;
        if (result.state === "PAID") {
          setSession("owned");
          setStatus("Доступ открыт.");
        } else {
          setStatus(result.state === "DECLINED" ? "Платёж отклонён." : result.state === "EXPIRED"
            ? "Время оплаты истекло."
            : "Статус платежа уточняется. Доступ откроется автоматически после подтверждения.");
        }
      })
      .catch(() => { if (active) setStatus("Статус платежа уточняется. Доступ откроется автоматически после подтверждения."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  const previewCheckout = async () => {
    if (!offerRef) return;
    setBusy(true); setStatus("Проверяем итоговую цену…");
    previewIdempotencyKey.current ??= crypto.randomUUID();
    try {
      const query = new URLSearchParams(window.location.search);
      const handoffToken = query.get("rt") || undefined;
      const handoffState = query.get("state") || undefined;
      if (!handoffToken) {
        const handoffResponse = await fetch("/v1/checkout/handoff", {
          method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
          body: JSON.stringify({ returnPath: pathname, storefront: "COURSES" }),
        });
        const handoff = await handoffResponse.json() as { required?: boolean; url?: string; code?: string };
        if (!handoffResponse.ok) throw new Error(handoff.code || "CHECKOUT_HANDOFF_FAILED");
        if (handoff.required && handoff.url) { window.location.assign(handoff.url); return; }
      }
      const response = await fetch("/v1/checkout/preview", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": previewIdempotencyKey.current },
        body: JSON.stringify({
          offerRef,
          handoffToken,
          state: handoffState,
          checkoutCode: checkoutCode.trim() || query.get("checkoutCode") || undefined,
          displayedAmountKopecks: priceKopecks ?? undefined,
        }),
      });
      const result = await response.json() as CheckoutQuote & CheckoutResult;
      if (!response.ok) throw new Error(result.code || "CHECKOUT_PREVIEW_FAILED");
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
      if (result.state !== "PRICE_REVIEW_REQUIRED" || !result.quoteId) throw new Error("CHECKOUT_QUOTE_INVALID");
      setQuote(result);
      setTermsAccepted(false);
      const codeMessage = checkoutCodeMessage(result.merchantPromotionCode, result.checkoutCodeOutcome);
      const priceMessage = result.priceNotice?.code === "PRICE_CHANGED_SINCE_DISPLAY"
        ? `Цена изменилась: было ${price(result.priceNotice.displayedAmountKopecks)}, сейчас ${price(result.priceNotice.quotedAmountKopecks)}.`
        : result.priceNotice?.code === "CATALOG_PRICE_CHANGED_AFTER_QUOTE"
          ? `Цена в каталоге изменилась на ${price(result.priceNotice.currentAmountKopecks)}; для этого расчёта сохраняется ${price(result.priceNotice.quotedAmountKopecks)}.`
          : "";
      setStatus(`${priceMessage}${priceMessage ? " " : ""}${codeMessage}${codeMessage ? " " : ""}${result.discountKopecks > 0
        ? `Скидка ${price(result.discountKopecks)}. Проверьте итог и подтвердите оплату.`
        : "Проверьте итоговую цену и подтвердите оплату."}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "CHECKOUT_PREVIEW_FAILED";
      if (code === "CONSENT_REQUIRED") {
        setConsentRequired(true);
        setStatus("Перед покупкой подтвердите актуальные документы аккаунта.");
      } else setStatus(code === "PAYMENTS_DISABLED" || code === "OFFER_CLOSED" ? "Продажи скоро." : "Не удалось начать оплату. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  const confirmCheckout = async () => {
    if (!quote || (quote.legalAcceptance && !termsAccepted)) return;
    setBusy(true); setStatus("Создаём заказ…");
    paymentIdempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/v1/checkout", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": paymentIdempotencyKey.current },
        body: JSON.stringify({ quoteId: quote.quoteId, state: new URLSearchParams(window.location.search).get("state") || undefined,
          ...(quote.legalAcceptance ? { legalAcceptance: { accepted: termsAccepted, releaseVersion: quote.legalAcceptance.releaseVersion,
            manifestSha256: quote.legalAcceptance.manifestSha256, receiptEmail: quote.legalAcceptance.receiptEmail } } : {}) }),
      });
      let result = await response.json() as CheckoutResult;
      if (!response.ok) throw new Error(result.code || "CHECKOUT_FAILED");
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return; }
      result = await observeCheckout(result);
      if (result.state === "PAID") { setSession("owned"); setStatus("Доступ открыт."); window.location.reload(); return; }
      setStatus(result.state === "DECLINED" ? "Платёж отклонён." : result.state === "EXPIRED" ? "Время оплаты истекло." : "Статус платежа уточняется. Попробуйте снова через минуту.");
    } catch (error) {
      const code = error instanceof Error ? error.message : "CHECKOUT_FAILED";
      if (code === "CONSENT_REQUIRED") {
        setConsentRequired(true);
        setTermsAccepted(false);
        setStatus("Перед покупкой подтвердите актуальные документы аккаунта.");
      } else if (["CHECKOUT_QUOTE_EXPIRED", "CHECKOUT_QUOTE_STALE", "CHECKOUT_QUOTE_UNAVAILABLE"].includes(code)) {
        setQuote(null); previewIdempotencyKey.current = null; paymentIdempotencyKey.current = null;
        setStatus("Цена изменилась или время подтверждения истекло. Проверьте её ещё раз.");
      } else setStatus(code === "PAYMENTS_DISABLED" || code === "OFFER_CLOSED" ? "Продажи скоро." : "Не удалось начать оплату. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  };

  if (session === "owned") return <div className="checkoutCta"><strong>Курс уже ваш</strong><p>Откройте любой урок из программы.</p></div>;
  if (saleMode === "CLOSED" || !offerRef || priceKopecks === null) return <div className="checkoutCta"><strong>Продажи скоро</strong><p>Курс появится в продаже после отдельного запуска платёжного контура.</p></div>;
  if (session === "anonymous") return <div className="checkoutCta"><strong>{price(priceKopecks)}</strong><Link className="primary" href={`/account?next=${encodeURIComponent(pathname)}`}>Войти, чтобы купить →</Link></div>;
  return <div className="checkoutCta">
    <strong>{price(quote?.finalAmountKopecks ?? priceKopecks)}</strong>
    {!quote && <label>Промокод
      <input autoComplete="off" disabled={busy} maxLength={64} onChange={(event) => setCheckoutCode(event.target.value)} value={checkoutCode} />
    </label>}
    {quote?.legalAcceptance && <div>
      <p>Электронный чек придёт на {quote.legalAcceptance.receiptEmail}.</p>
      <ul>{quote.legalAcceptance.documents.map(document => <li key={document.kind}>
        <a href={document.url} target="_blank" rel="noopener noreferrer">{documentLabels[document.kind] ?? "Документ покупки"}</a>
      </li>)}</ul>
      <label><input type="checkbox" checked={termsAccepted} disabled={busy}
        onChange={event => setTermsAccepted(event.target.checked)} />
        Принимаю условия покупки и возврата, ознакомился с обработкой данных и направлением чека.
      </label>
    </div>}
    {consentRequired && <Link href={`/account?next=${encodeURIComponent(pathname)}`}>Проверить документы аккаунта →</Link>}
    <button className="primary" disabled={busy || consentRequired || session === "loading" || Boolean(quote?.legalAcceptance && !termsAccepted)} type="button" onClick={() => void (quote ? confirmCheckout() : previewCheckout())}>
      {busy ? "Проверяем…" : quote ? "Подтвердить и оплатить →" : "Купить курс →"}
    </button>
    {quote && quote.discountKopecks > 0 && <p>
      Цена курса {price(quote.baseAmountKopecks)}
      {quote.merchantDiscountKopecks > 0 && <> · промо Flexperiment {price(quote.merchantDiscountKopecks)}</>}
      {quote.referralDiscountKopecks > 0 && <> · скидка Refref {price(quote.referralDiscountKopecks)}</>}
      {` · итог ${price(quote.finalAmountKopecks)}`}
    </p>}
    {status && <p role="status">{status}</p>}
  </div>;
}
