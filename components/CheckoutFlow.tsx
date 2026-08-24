"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { commerceApiUrl } from "@/lib/commerce-api";
import { ensureCurrentReferralCapture } from "@/components/referral-capture-client";
import { referralCaptureCoordinator } from "@/components/referral-capture-state";
import { storedReferralSlug } from "@/components/referral-marker";
import CityInterestForm from "@/components/CityInterestForm";
import { findCityBySlug, type CitySlug } from "@/lib/city-catalog";
import { canRequestCheckout, isPublicOccurrenceSelectable, salesAnnouncement, type PublicSalesStatus } from "@/lib/occurrence-sales";
import { getParticipantAgeOnOccurrenceDate } from "@/lib/participant-age";
import { formatRubles as rub } from "@/lib/money";

type Occurrence = {
  id: string;
  city: string;
  city_title: string;
  title: string;
  starts_at: string;
  timezone: string;
  price_kopecks: number;
  availability: number;
  sales_status: PublicSalesStatus;
  fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
};
type Quote = {
  quote_id: string;
  final_amount_kopecks: number;
  discount_kopecks: number;
  venue_disclosure: string;
  expires_at: string;
  legal_release: {
    version: string;
    manifest: {
      documents: Record<"PUBLIC_OFFER" | "PRIVACY_POLICY" | "PD_CONSENT" | "CHECKOUT_DISCLOSURE", { version: string; archive_url: string }>;
    };
  };
};
type Attempt = { version: 1; idempotencyKey: string; statusId: string | null };

const attemptKey = (quoteId: string) => `fx_checkout_attempt:v1:${quoteId}`;

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
  const [customerAdult, setCustomerAdult] = useState(false);
  const [participantSelf, setParticipantSelf] = useState(true);
  const [participantName, setParticipantName] = useState("");
  const [participantDateOfBirth, setParticipantDateOfBirth] = useState("");
  const [minorRepresentative, setMinorRepresentative] = useState(false);
  const [under14Accompaniment, setUnder14Accompaniment] = useState(false);
  const [offer, setOffer] = useState(false);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduledCitySlugs, setScheduledCitySlugs] = useState<CitySlug[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const selected = useMemo(() => occurrences.find((item) => item.id === occurrenceId), [occurrences, occurrenceId]);
  const canCheckout = canRequestCheckout(selected);
  const participantAge = useMemo(() => selected && participantDateOfBirth
    ? getParticipantAgeOnOccurrenceDate(participantDateOfBirth, selected.starts_at, selected.timezone)
    : null, [participantDateOfBirth, selected]);
  const legalLabels = {
    PUBLIC_OFFER: "публичной оферты",
    PRIVACY_POLICY: "политики конфиденциальности",
    PD_CONSENT: "согласия на обработку персональных данных",
    CHECKOUT_DISCLOSURE: "информации об участии",
  } as const;

  useEffect(() => {
    let current = true;
    fetch(commerceApiUrl("/v1/public/tour"), { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : Promise.reject(new Error("TOUR_UNAVAILABLE")))
      .then((data: { cities: Occurrence[] }) => {
        if (!current) return;
        const available = data.cities.filter(isPublicOccurrenceSelectable);
        const initial = available.find(canRequestCheckout) ?? available[0];
        setOccurrences(available); setOccurrenceId(initial?.id ?? "");
        const scheduledCities = data.cities
          .filter((item) => item.fulfillment_status === "SCHEDULED")
          .map((item) => findCityBySlug(item.city))
          .filter((city): city is NonNullable<typeof city> => Boolean(city))
          .map((city) => city.slug);
        setScheduledCitySlugs([...new Set(scheduledCities)]);
        setCatalogLoaded(true);
      })
      .catch(() => current && setMessage("Сейчас запись недоступна. Пожалуйста, попробуйте позже."))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, []);

  const fetchQuote = useCallback(async (id: string, promo: string) => {
    if (!id) return;
    setLoading(true); setMessage(null);
    try {
      await ensureCurrentReferralCapture();
      await referralCaptureCoordinator.waitForCurrentCapture();
      const response = await fetch(commerceApiUrl("/v1/public/checkout-context"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurrence_id: id, promo_code: promo || undefined, referral_slug: storedReferralSlug(document.cookie) ?? undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.code ?? "QUOTE_UNAVAILABLE");
      setQuote(data); setCustomerAdult(false); setMinorRepresentative(false); setUnder14Accompaniment(false); setOffer(false); setConsent(false);
    } catch (error) {
      setQuote(null);
      setMessage(error instanceof Error && error.message === "SALES_NOT_OPEN"
        ? "Продажи пока закрыты."
        : "Не удалось получить актуальные условия. Проверьте соединение и повторите попытку.");
    } finally { setLoading(false); }
  }, []);

  const refreshQuote = async (event?: FormEvent) => { event?.preventDefault(); await fetchQuote(occurrenceId, promoCode); };

  useEffect(() => {
    if (!occurrenceId || !canCheckout) return;
    const timer = window.setTimeout(() => { void fetchQuote(occurrenceId, ""); }, 0);
    return () => window.clearTimeout(timer);
  }, [canCheckout, fetchQuote, occurrenceId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!quote || submitting) return;
    if (participantSelf && participantAge?.isMinor) {
      setMessage("Заказчик должен быть совершеннолетним. Для несовершеннолетнего участника выберите «Другой человек».");
      return;
    }
    setSubmitting(true); setMessage(null);
    const key = attemptKey(quote.quote_id);
    let attempt: Attempt;
    try { attempt = JSON.parse(storage.get(key) ?? "") as Attempt; }
    catch { attempt = { version: 1, idempotencyKey: crypto.randomUUID(), statusId: null }; }
    if (!attempt?.idempotencyKey) attempt = { version: 1, idempotencyKey: crypto.randomUUID(), statusId: null };
    const stored = storage.set(key, JSON.stringify(attempt));
    if (!stored) setMessage("Не закрывайте страницу до завершения оплаты: браузер не дал сохранить попытку.");
    try {
      const response = await fetch(commerceApiUrl("/v1/public/checkouts"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
        body: JSON.stringify({ quote_id: quote.quote_id, customer_name: name, customer_email: email, customer_adult_confirmed: customerAdult, participant: { self: participantSelf, name: participantSelf ? undefined : participantName, date_of_birth: participantDateOfBirth }, minor_legal_representative_confirmed: participantAge?.isMinor ? minorRepresentative : undefined, under_14_accompaniment_confirmed: participantAge?.requiresAdultAccompaniment ? under14Accompaniment : undefined, offer_accepted: offer, pd_consent_accepted: consent }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (["QUOTE_STALE", "PROMO_NO_LONGER_ELIGIBLE", "LEGAL_VERSION_CHANGED"].includes(data.error?.code)) {
          setQuote(null); setCustomerAdult(false); setMinorRepresentative(false); setUnder14Accompaniment(false); setOffer(false); setConsent(false);
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
  if (!occurrences.length) return <div><p className="py-8 text-center font-mono text-sm text-bone/70">{catalogLoaded ? "Запись на ближайшие даты пока не открыта." : "Сейчас запись недоступна. Пожалуйста, попробуйте позже."}</p>{catalogLoaded && <CityInterestForm scheduledCitySlugs={scheduledCitySlugs} />}</div>;

  return (
    <>
    <form className="space-y-4 font-mono text-sm" onSubmit={submit}>
      <label className="grid gap-1.5">Город и дата
        <select value={occurrenceId} onChange={(event) => setOccurrenceId(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid">
          {occurrences.map((item) => <option value={item.id} key={item.id}>{item.city_title} — {new Date(item.starts_at).toLocaleDateString("ru-RU")} · {item.title}{item.sales_status === "CLOSED" ? " · продажи закрыты" : item.sales_status === "PAUSED" ? " · продажи приостановлены" : ""}</option>)}
        </select>
      </label>
      {!canCheckout ? <p role="status" className="border border-bone/50 px-3 py-2 text-bone/70">{salesAnnouncement(selected?.sales_status)}</p> : <>
      <label className="grid gap-1.5">Промокод <input value={promoCode} onChange={(event) => setPromoCode(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <button type="button" onClick={() => void refreshQuote()} className="text-left text-acid underline underline-offset-4">Обновить стоимость</button>
      {quote && <div className="border border-acid/60 p-3 text-bone"><p>{selected?.city_title}: {rub(quote.final_amount_kopecks)}{quote.discount_kopecks > 0 ? " со скидкой" : ""}</p><p className="mt-1 text-bone/70">{quote.venue_disclosure}</p></div>}
      <label className="grid gap-1.5">Имя <input required value={name} onChange={(event) => setName(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <label className="grid gap-1.5">Email <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <fieldset className="grid gap-2 border border-bone/50 p-3"><legend className="px-1">Кто будет участвовать?</legend><label><input type="radio" checked={participantSelf} onChange={() => setParticipantSelf(true)} /> Я сам</label><label><input type="radio" checked={!participantSelf} onChange={() => setParticipantSelf(false)} /> Другой человек</label>{!participantSelf && <label className="grid gap-1.5">Имя участника <input required value={participantName} onChange={(event) => setParticipantName(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>}<label className="grid gap-1.5">Дата рождения участника <input required type="date" value={participantDateOfBirth} onChange={(event) => setParticipantDateOfBirth(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>{participantSelf && participantAge?.isMinor && <p role="status" className="text-acid">Заказчик должен быть совершеннолетним. Для несовершеннолетнего участника выберите «Другой человек».</p>}{!participantSelf && participantAge?.isMinor && <label><input required type="checkbox" checked={minorRepresentative} onChange={(event) => setMinorRepresentative(event.target.checked)} /> Я являюсь законным представителем указанного несовершеннолетнего участника и разрешаю ему принять участие в выбранном мастер-классе.</label>}{!participantSelf && participantAge?.requiresAdultAccompaniment && <label><input required type="checkbox" checked={under14Accompaniment} onChange={(event) => setUnder14Accompaniment(event.target.checked)} /> Я понимаю, что участник младше 14 лет должен находиться на площадке мастер-класса в сопровождении совершеннолетнего взрослого в течение всего мероприятия.</label>}<p className="text-bone/70">Возраст участников не ограничен. Для несовершеннолетних билет оформляет совершеннолетний законный представитель. Участники младше 14 лет посещают мастер-класс в сопровождении взрослого.</p></fieldset>
      <div className="grid gap-2 text-xs leading-snug">
        <label><input required type="checkbox" checked={customerAdult} onChange={(event) => setCustomerAdult(event.target.checked)} /> Мне исполнилось 18 лет. Я оформляю заказ от своего имени.</label>
        <label><input required type="checkbox" checked={offer} onChange={(event) => setOffer(event.target.checked)} /> Я принимаю условия {quote ? <a className="text-acid underline underline-offset-4" href={quote.legal_release.manifest.documents.PUBLIC_OFFER.archive_url} target="_blank" rel="noreferrer">{legalLabels.PUBLIC_OFFER}</a> : "публичной оферты"}.</label>
        <label><input required type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Я даю согласие на обработку моих персональных данных как Заказчика.</label>
        {quote && <p className="text-bone/70">Версия legal release {quote.legal_release.version}: {(Object.keys(legalLabels) as (keyof typeof legalLabels)[]).map((id, index) => <span key={id}>{index > 0 ? " · " : ""}<a className="text-acid underline underline-offset-4" href={quote.legal_release.manifest.documents[id].archive_url} target="_blank" rel="noreferrer">{legalLabels[id]}</a></span>)}</p>}
      </div>
      {message && <p role="status" className="border border-acid px-3 py-2 text-acid">{message}</p>}
      <button disabled={!quote || submitting} className="w-full border-2 border-acid bg-acid px-4 py-3 font-display text-lg uppercase text-ink disabled:cursor-wait disabled:opacity-60">{submitting ? "Создаём оплату…" : "Перейти к оплате"}</button>
      </>}
    </form>
    <CityInterestForm scheduledCitySlugs={scheduledCitySlugs} />
    </>
  );
}
