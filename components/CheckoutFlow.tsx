"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Occurrence = {
  id: string;
  city: string;
  city_title: string;
  title: string;
  starts_at: string;
  price_kopecks: number;
  availability: number;
};
type Quote = {
  quote_id: string;
  final_amount_kopecks: number;
  discount_kopecks: number;
  venue_disclosure: string;
  expires_at: string;
};
type Attempt = { version: 1; idempotencyKey: string; statusId: string | null };

const attemptKey = (quoteId: string) => `fx_checkout_attempt:v1:${quoteId}`;
const rub = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(kopecks / 100);

function useSafeSessionStorage() {
  return {
    get(key: string) { try { return window.sessionStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { window.sessionStorage.setItem(key, value); return true; } catch { return false; } },
  };
}

export default function CheckoutFlow() {
  const router = useRouter();
  const storage = useSafeSessionStorage();
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [occurrenceId, setOccurrenceId] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [eligibility, setEligibility] = useState(false);
  const [offer, setOffer] = useState(false);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(() => occurrences.find((item) => item.id === occurrenceId), [occurrences, occurrenceId]);

  useEffect(() => {
    let current = true;
    fetch("/v1/public/tour", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("TOUR_UNAVAILABLE")))
      .then((data: { cities: Occurrence[] }) => {
        if (!current) return;
        const available = data.cities.filter((item) => item.id && item.availability > 0);
        setOccurrences(available); setOccurrenceId(available[0]?.id ?? "");
      })
      .catch(() => current && setMessage("Сейчас запись недоступна. Пожалуйста, попробуйте позже."))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, []);

  const fetchQuote = useCallback(async (id: string, promo: string) => {
    if (!id) return;
    setLoading(true); setMessage(null);
    try {
      const response = await fetch("/v1/public/checkout-context", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurrence_id: id, promo_code: promo || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.code ?? "QUOTE_UNAVAILABLE");
      setQuote(data); setEligibility(false); setOffer(false); setConsent(false);
    } catch {
      setQuote(null); setMessage("Не удалось получить актуальные условия. Проверьте соединение и повторите попытку.");
    } finally { setLoading(false); }
  }, []);

  const refreshQuote = async (event?: FormEvent) => { event?.preventDefault(); await fetchQuote(occurrenceId, promoCode); };

  useEffect(() => {
    if (!occurrenceId) return;
    const timer = window.setTimeout(() => { void fetchQuote(occurrenceId, ""); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchQuote, occurrenceId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!quote || submitting) return;
    setSubmitting(true); setMessage(null);
    const key = attemptKey(quote.quote_id);
    let attempt: Attempt;
    try { attempt = JSON.parse(storage.get(key) ?? "") as Attempt; }
    catch { attempt = { version: 1, idempotencyKey: crypto.randomUUID(), statusId: null }; }
    if (!attempt?.idempotencyKey) attempt = { version: 1, idempotencyKey: crypto.randomUUID(), statusId: null };
    const stored = storage.set(key, JSON.stringify(attempt));
    if (!stored) setMessage("Не закрывайте страницу до завершения оплаты: браузер не дал сохранить попытку.");
    try {
      const response = await fetch("/v1/public/checkouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
        body: JSON.stringify({ quote_id: quote.quote_id, customer_name: name, customer_email: email, eligibility_confirmed: eligibility, offer_accepted: offer, pd_consent_accepted: consent }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (["QUOTE_STALE", "PROMO_NO_LONGER_ELIGIBLE", "LEGAL_VERSION_CHANGED"].includes(data.error?.code)) {
          setQuote(null); setEligibility(false); setOffer(false); setConsent(false);
          setMessage("Условия изменились. Мы обновили форму — подтвердите условия заново.");
          await refreshQuote();
          return;
        }
        throw new Error(data.error?.code ?? "CHECKOUT_FAILED");
      }
      attempt.statusId = data.status_id; storage.set(key, JSON.stringify(attempt));
      if (data.payment_url) { window.location.href = data.payment_url; return; }
      router.push(`/payment/success?order=${encodeURIComponent(data.status_id)}`);
    } catch {
      setMessage("Не удалось начать оплату. Повторите попытку — второй заказ не будет создан.");
    } finally { setSubmitting(false); }
  };

  if (loading && !occurrences.length) return <p className="py-8 text-center font-mono text-sm text-bone/70">Загрузка дат…</p>;
  if (!occurrences.length) return <p className="py-8 text-center font-mono text-sm text-bone/70">Запись на ближайшие даты пока не открыта.</p>;

  return (
    <form className="space-y-4 font-mono text-sm" onSubmit={submit}>
      <label className="grid gap-1.5">Город и дата
        <select value={occurrenceId} onChange={(event) => setOccurrenceId(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid">
          {occurrences.map((item) => <option value={item.id} key={item.id}>{item.city_title} — {new Date(item.starts_at).toLocaleDateString("ru-RU")} · {item.title}</option>)}
        </select>
      </label>
      <label className="grid gap-1.5">Промокод <input value={promoCode} onChange={(event) => setPromoCode(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <button type="button" onClick={() => void refreshQuote()} className="text-left text-acid underline underline-offset-4">Обновить стоимость</button>
      {quote && <div className="border border-acid/60 p-3 text-bone"><p>{selected?.city_title}: {rub(quote.final_amount_kopecks)}{quote.discount_kopecks > 0 ? " со скидкой" : ""}</p><p className="mt-1 text-bone/70">{quote.venue_disclosure}</p></div>}
      <label className="grid gap-1.5">Имя <input required value={name} onChange={(event) => setName(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <label className="grid gap-1.5">Email <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <div className="grid gap-2 text-xs leading-snug">
        <label><input required type="checkbox" checked={eligibility} onChange={(event) => setEligibility(event.target.checked)} /> Мне исполнилось 18 лет, я покупаю билет для себя.</label>
        <label><input required type="checkbox" checked={offer} onChange={(event) => setOffer(event.target.checked)} /> Я принимаю условия публичной оферты.</label>
        <label><input required type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Я даю согласие на обработку персональных данных.</label>
      </div>
      {message && <p role="status" className="border border-acid px-3 py-2 text-acid">{message}</p>}
      <button disabled={!quote || submitting} className="w-full border-2 border-acid bg-acid px-4 py-3 font-display text-lg uppercase text-ink disabled:cursor-wait disabled:opacity-60">{submitting ? "Создаём оплату…" : "Перейти к оплате"}</button>
    </form>
  );
}
