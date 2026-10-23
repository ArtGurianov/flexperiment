"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { checkoutCodeMessage } from "../../../lib/checkout-code";
import { commerceApiUrl } from "../../../lib/commerce-api";
import { labGuestQuoteSchema, type LabGuestQuote } from "../../../lib/lab-guest-contract";

export const newLabCapability = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export async function labRequest(path: string, body?: unknown, token?: string, key?: string) {
  const response = await fetch(commerceApiUrl(path), { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.code ?? "LAB_UNAVAILABLE");
  return result;
}
type Session = { accessToken: string; previewKey: string; paymentKey: string; email: string; checkoutCode?: string; orderPublicId?: string };
const money = (kopecks: number) => (kopecks / 100).toLocaleString("ru-RU") + " ₽";
export default function LabGuestCheckout({ offerRef, displayedAmountKopecks }: { offerRef: string; displayedAmountKopecks: number }) {
  const router = useRouter();
  const [ticketLink, setTicketLink] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [checkoutCode, setCheckoutCode] = useState("");
  const [quote, setQuote] = useState<LabGuestQuote | null>(null);
  const [personalData, setPersonalData] = useState(false), [terms, setTerms] = useState(false), [receiptContact, setReceiptContact] = useState(false);
  const accepted = personalData && terms && receiptContact;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const session = useRef<Session | null>(null);
  const lock = useRef(false);
  const storageKey = `lab-guest-v1:${offerRef}`;
  const preview = async (event?: FormEvent, restoring = false) => {
    event?.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setMessage("");
    try {
      const stored = sessionStorage.getItem(storageKey);
      const previous = stored ? JSON.parse(stored) as Session : null;
      const contact = restoring && previous ? previous.email : email.trim().toLowerCase();
      if (previous && previous.email !== contact) throw new Error("LAB_CONTACT_CHANGED");
      const current = previous ?? { accessToken: newLabCapability(), previewKey: crypto.randomUUID(), paymentKey: crypto.randomUUID(), email: contact, checkoutCode: checkoutCode.trim() };
      setEmail(current.email); setCheckoutCode(current.checkoutCode ?? "");
      session.current = current;
      // Save before the first request: a lost answer cannot create a fresh purchase intent on retry.
      sessionStorage.setItem(storageKey, JSON.stringify(current));
      const started = await labRequest("/v1/lab/guest/start", { email: current.email, accessToken: current.accessToken });
      current.orderPublicId = started.orderPublicId;
      setTicketLink(`/ticket#access=${current.accessToken}`);
      sessionStorage.setItem(storageKey, JSON.stringify(current));
      sessionStorage.setItem("lab-ticket-v1", JSON.stringify({ accessToken: current.accessToken, orderPublicId: current.orderPublicId }));
      const result = await labRequest("/v1/checkout/preview", { offerRef, displayedAmountKopecks, checkoutCode: current.checkoutCode || undefined }, current.accessToken, current.previewKey);
      if (result.state === "RESOLUTION_PENDING") { setMessage("Уточняем условия. Повторите проверку — повторной оплаты не будет."); return; }
      if (result.orderPublicId && ["PAID", "PENDING", "CREATE_UNKNOWN", "CUSTOMER_ACTION_REQUIRED"].includes(result.state)) {
        if (result.checkoutUrl && new URL(result.checkoutUrl).protocol === "https:") window.location.assign(result.checkoutUrl);
        else router.push(`/ticket#access=${current.accessToken}`);
        return;
      }
      setQuote(labGuestQuoteSchema.parse(result)); setPersonalData(false); setTerms(false); setReceiptContact(false);
    } catch { setMessage("Не удалось подготовить заказ. Повторите с тем же email. Условия или доступность встречи могли измениться."); }
    finally { lock.current = false; setBusy(false); }
  };
  const pay = async () => {
    if (lock.current || !accepted || !quote || !session.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      const current = session.current;
      const result = await labRequest("/v1/checkout", { quoteId: quote.quoteId, labAcceptance: { personalDataConsent: true,
        termsAccepted: true, receiptContactAccepted: true, releaseVersion: quote.labLegal.releaseVersion, manifestSha256: quote.labLegal.manifestSha256 } }, current.accessToken, current.paymentKey);
      if (result.checkoutUrl && new URL(result.checkoutUrl).protocol === "https:") window.location.assign(result.checkoutUrl);
      else router.push(`/ticket#access=${current.accessToken}`);
    } catch { setMessage("Не удалось получить результат оплаты. Проверьте заказ по ссылке на билет; повторное нажатие использует тот же заказ."); }
    finally { lock.current = false; setBusy(false); }
  };
  const restoreCheckout = useEffectEvent(() => preview(undefined, true));
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active && sessionStorage.getItem(storageKey)) void restoreCheckout(); });
    return () => { active = false; };
  }, [storageKey]);
  return <div className="guestCheckout">
    <p>Билет без регистрации. Email нужен для билета, чека и восстановления.</p>
    {!quote ? <form onSubmit={preview}><label>Email для билета и чека<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Промокод<input autoComplete="off" maxLength={64} disabled={busy} value={checkoutCode} onChange={event => setCheckoutCode(event.target.value)} /></label>
      <button disabled={busy}>{busy ? "Проверяем…" : "Проверить условия"}</button></form>
      : <div><h4>{quote.occurrence.title}</h4><p>{new Date(quote.occurrence.startsAt).toLocaleString("ru-RU", { timeZone: quote.occurrence.timezone })}</p>
        <p>{quote.occurrence.venue.status === "CONFIRMED" ? `${quote.occurrence.venue.name}, ${quote.occurrence.venue.address}` : quote.occurrence.venue.disclosureText}</p>
        {quote.priceNotice ? <p role="status">{quote.priceNotice.code === "PRICE_CHANGED_SINCE_DISPLAY"
          ? `Цена изменилась: было ${money(quote.priceNotice.displayedAmountKopecks)}, сейчас ${money(quote.priceNotice.quotedAmountKopecks)}.`
          : `Цена в каталоге изменилась на ${money(quote.priceNotice.currentAmountKopecks)}; для этого расчёта сохраняется ${money(quote.priceNotice.quotedAmountKopecks)}.`}</p> : null}
        {quote.checkoutCodeOutcome && <p>{checkoutCodeMessage(quote.merchantPromotionCode ?? null, quote.checkoutCodeOutcome)}</p>}
        <p>К оплате: {(quote.finalAmountKopecks / 100).toLocaleString("ru-RU")} ₽</p><p>Условия действуют до {new Date(quote.expiresAt).toLocaleTimeString("ru-RU")}.</p>
        <ul>{quote.labLegal.documents.filter(document => ["privacy", "personal_data", "course_offer", "receipt_contact", "refund_terms"].includes(document.kind)).map(document =>
          <li key={document.kind}><a href={document.url} target="_blank" rel="noreferrer">{({ privacy: "Политика конфиденциальности", personal_data: "Согласие на обработку данных", course_offer: "Оферта LAB", receipt_contact: "Контакт для чека", refund_terms: "Условия возврата" } as Record<string, string>)[document.kind]}</a></li>)}</ul>
        <label className="consent"><input type="checkbox" checked={personalData} onChange={event => setPersonalData(event.target.checked)} />Согласен на обработку персональных данных для заказа.</label>
        <label className="consent"><input type="checkbox" checked={terms} onChange={event => setTerms(event.target.checked)} />Принимаю оферту и условия возврата LAB.</label>
        <label className="consent"><input type="checkbox" checked={receiptContact} onChange={event => setReceiptContact(event.target.checked)} />Получить билет и чек на {email}.</label>
        <button disabled={busy || !accepted} onClick={pay}>{busy ? "Проверяем заказ…" : "Подтвердить и оплатить"}</button>
      </div>}
    {ticketLink && <Link href={ticketLink}>Проверить заказ и билет</Link>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
