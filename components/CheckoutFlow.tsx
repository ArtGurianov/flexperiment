"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { commerceApiUrl } from "@/lib/commerce-api";
import { ensureCurrentReferralCapture } from "@/components/referral-capture-client";
import { referralCaptureCoordinator } from "@/components/referral-capture-state";
import { storedReferralSlug } from "@/components/referral-marker";
import CityInterestForm from "@/components/CityInterestForm";
import OccurrenceNotifyForm from "@/components/OccurrenceNotifyForm";
import { findCityBySlug, type CitySlug } from "@/lib/city-catalog";
import { canRequestCheckout, purchaseStatusAnnouncement, type PurchaseStatus } from "@/lib/occurrence-sales";
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
  sales_status: "OPEN" | "PAUSED" | "CLOSED";
  fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  purchase_status: PurchaseStatus;
  venue: {
    status: "CONFIRMED" | "TO_BE_ANNOUNCED";
    name: string | null;
    address: string | null;
    disclosure_text: string | null;
    announce_by: string | null;
  };
};
type Quote = {
  quote_id: string;
  price_kopecks: number;
  final_amount_kopecks: number;
  discount_kopecks: number;
  promo: null | { id: string; code: string; discount_type: "NONE" | "PERCENT" | "FIXED"; discount_value: number; discount_kopecks: number };
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
type ParticipantAgeBand = "ADULT" | "MINOR_14_17" | "MINOR_UNDER_14";
type Props = {
  onViewChange: (view: "booking" | "city-interest") => void;
  onBookingTitle: (title: string) => void;
};

const attemptKey = (quoteId: string) => `fx_checkout_attempt:v1:${quoteId}`;
const occurrenceDateLabel = (startsAt: string) => {
  const date = new Date(startsAt);
  return Number.isNaN(date.getTime()) ? "Скоро" : date.toLocaleDateString("ru-RU");
};
const occurrenceDateTimeLabel = (startsAt: string, timeZone: string) => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "Время уточняется";
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};
const publicVenueDisclosure = (occurrence: Occurrence) => {
  const { venue } = occurrence;
  if (venue.status === "CONFIRMED") {
    return venue.name && venue.address
      ? `${venue.name}: ${venue.address}`
      : "Точное место проведения будет доступно при записи.";
  }
  const deadline = venue.announce_by
    ? ` Сообщим адрес участникам на email не позднее ${occurrenceDateTimeLabel(venue.announce_by, occurrence.timezone)}.`
    : "";
  return `${venue.disclosure_text ?? "Площадка уточняется."}${deadline}`;
};
const legalPagePaths = {
  PUBLIC_OFFER: "/legal/public-offer",
  PRIVACY_POLICY: "/legal/privacy-policy",
  PD_CONSENT: "/legal/personal-data-consent",
  CHECKOUT_DISCLOSURE: "/legal/disclaimer",
} as const;

function useSafeSessionStorage() {
  return {
    get(key: string) { try { return window.sessionStorage.getItem(key); } catch { return null; } },
    set(key: string, value: string) { try { window.sessionStorage.setItem(key, value); return true; } catch { return false; } },
  };
}

export default function CheckoutFlow({ onViewChange, onBookingTitle }: Props) {
  const router = useRouter();
  const storage = useSafeSessionStorage();
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [occurrenceId, setOccurrenceId] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromoCode, setAppliedPromoCode] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [email, setEmail] = useState("");
  const [customerAdult, setCustomerAdult] = useState(false);
  const [participantAgeBand, setParticipantAgeBand] = useState<ParticipantAgeBand | "">("");
  const [minorRepresentative, setMinorRepresentative] = useState(false);
  const [offer, setOffer] = useState(false);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduledCitySlugs, setScheduledCitySlugs] = useState<CitySlug[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [occurrenceNotificationsAvailable, setOccurrenceNotificationsAvailable] = useState(false);
  const [view, setView] = useState<"catalog" | "booking" | "city-interest">("catalog");
  const selected = useMemo(() => occurrences.find((item) => item.id === occurrenceId), [occurrences, occurrenceId]);
  const canCheckout = canRequestCheckout(selected);
  const participantIsMinor = participantAgeBand !== "" && participantAgeBand !== "ADULT";
  const participantRequiresAdultAccompaniment = participantAgeBand === "MINOR_UNDER_14";
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
        const available = data.cities;
        setOccurrences(available); setOccurrenceId("");
        const scheduledCities = data.cities
          .filter((item) => item.fulfillment_status === "SCHEDULED")
          .map((item) => findCityBySlug(item.city))
          .filter((city): city is NonNullable<typeof city> => Boolean(city))
          .map((city) => city.slug);
        setScheduledCitySlugs([...new Set(scheduledCities)]);
        setCatalogState("ready");
      })
      .catch(() => current && setCatalogState("error"))
      .finally(() => current && setLoading(false));
    fetch(commerceApiUrl("/v1/public/legal-config"), { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { occurrence_notifications_available: false })
      .then((data: { occurrence_notifications_available?: boolean }) => current && setOccurrenceNotificationsAvailable(data.occurrence_notifications_available === true))
      .catch(() => current && setOccurrenceNotificationsAvailable(false));
    return () => { current = false; };
  }, []);

  const fetchQuote = useCallback(async (id: string, promo: string, options?: { clearMessage?: boolean }) => {
    if (!id) return false;
    setLoading(true); if (options?.clearMessage !== false) setMessage(null);
    try {
      await ensureCurrentReferralCapture();
      await referralCaptureCoordinator.waitForCurrentCapture();
      const response = await fetch(commerceApiUrl("/v1/public/checkout-context"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurrence_id: id, promo_code: promo || undefined, referral_slug: storedReferralSlug(document.cookie) ?? undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.code ?? "QUOTE_UNAVAILABLE");
      setQuote(data); setCustomerAdult(false); setMinorRepresentative(false); setOffer(false); setConsent(false);
      return true;
    } catch (error) {
      setQuote(null);
      const code = error instanceof Error ? error.message : "QUOTE_UNAVAILABLE";
      if (["SOLD_OUT", "SALES_NOT_OPEN", "SALES_TEMPORARILY_PAUSED"].includes(code)) {
        try {
          const response = await fetch(commerceApiUrl(`/v1/public/occurrences/${encodeURIComponent(id)}`), { cache: "no-store" });
          if (response.ok) { const current = await response.json() as Occurrence; setOccurrences((items) => items.map((item) => item.id === id ? current : item)); }
        } catch { /* the message below remains honest if the refresh also fails */ }
      }
      setMessage(["SALES_NOT_OPEN", "SOLD_OUT", "SALES_TEMPORARILY_PAUSED"].includes(code) ? "Состояние записи изменилось. Обновляем дату…"
        : code === "PROMO_NOT_FOUND" ? "Промокод не найден."
        : ["PROMO_NOT_ELIGIBLE", "PROMO_ZERO_PRICE_NOT_ALLOWED"].includes(code) ? "Промокод недоступен."
        : "Не удалось получить актуальные условия. Проверьте соединение и повторите попытку.");
      return false;
    } finally { setLoading(false); }
  }, []);

  const refreshOccurrenceState = useCallback(async (id: string) => {
    setQuote(null); setCustomerAdult(false); setMinorRepresentative(false); setOffer(false); setConsent(false);
    try {
      const response = await fetch(commerceApiUrl(`/v1/public/occurrences/${encodeURIComponent(id)}`), { cache: "no-store" });
      if (!response.ok) throw new Error("OCCURRENCE_REFRESH_FAILED");
      const current = await response.json() as Occurrence;
      setOccurrences((items) => items.map((item) => item.id === id ? current : item));
      setMessage(null);
    } catch { setMessage("Не удалось обновить состояние даты. Проверьте соединение и повторите попытку."); }
  }, []);

  const applyPromo = async () => {
    const code = promoCode.trim().toUpperCase();
    const applied = await fetchQuote(occurrenceId, code);
    if (applied && code) {
      setPromoCode(code);
      setAppliedPromoCode(code);
    }
  };

  const resetPromo = async () => {
    if (await fetchQuote(occurrenceId, "")) {
      setPromoCode("");
      setAppliedPromoCode(null);
    }
  };

  const showBooking = (occurrence: Occurrence) => {
    setOccurrenceId(occurrence.id);
    setPromoCode("");
    setAppliedPromoCode(null);
    setQuote(null);
    setCustomerAdult(false);
    setParticipantAgeBand("");
    setMinorRepresentative(false);
    setOffer(false);
    setConsent(false);
    setMessage(null);
    onBookingTitle(`${occurrence.city_title} × ${occurrenceDateLabel(occurrence.starts_at)}`);
    setView("booking");
    onViewChange("booking");
  };

  const showCityInterest = () => {
    setView("city-interest");
    onViewChange("city-interest");
  };

  useEffect(() => {
    if (!occurrenceId || !canCheckout) return;
    const timer = window.setTimeout(() => { void fetchQuote(occurrenceId, ""); }, 0);
    return () => window.clearTimeout(timer);
  }, [canCheckout, fetchQuote, occurrenceId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!quote || !participantAgeBand || submitting) return;
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
        body: JSON.stringify({ quote_id: quote.quote_id, customer_email: email, customer_adult_confirmed: customerAdult, participant_age_band: participantAgeBand, minor_legal_representative_confirmed: participantIsMinor ? minorRepresentative : undefined, offer_accepted: offer, pd_consent_accepted: consent }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (["QUOTE_STALE", "PROMO_NO_LONGER_ELIGIBLE", "LEGAL_VERSION_CHANGED"].includes(data.error?.code)) {
          setQuote(null); setCustomerAdult(false); setMinorRepresentative(false); setOffer(false); setConsent(false);
          if (data.error?.code === "PROMO_NO_LONGER_ELIGIBLE") {
            setPromoCode(""); setAppliedPromoCode(null);
            setMessage("Промокод больше недоступен. Мы показали цену без него — подтвердите условия заново.");
            await fetchQuote(occurrenceId, "", { clearMessage: false });
          } else {
            setMessage("Условия изменились. Мы обновили форму — подтвердите условия заново.");
            await fetchQuote(occurrenceId, appliedPromoCode ?? "", { clearMessage: false });
          }
          return;
        }
        const code = data.error?.code ?? "CHECKOUT_FAILED";
        if (["SOLD_OUT", "SALES_NOT_OPEN", "SALES_TEMPORARILY_PAUSED"].includes(code)) { await refreshOccurrenceState(occurrenceId); return; }
        throw new Error(code);
      }
      attempt.statusId = data.status_id; storage.set(key, JSON.stringify(attempt));
      if (data.payment_url) { window.location.href = data.payment_url; return; }
      router.push(`/payment/success?order=${encodeURIComponent(data.status_id)}`);
    } catch {
      setMessage("Не удалось начать оплату. Повторите попытку — второй заказ не будет создан.");
    } finally { setSubmitting(false); }
  };

  if (view === "city-interest") return <CityInterestForm scheduledCitySlugs={scheduledCitySlugs} />;

  if (view === "catalog") return (
    <div className="flex w-full flex-col gap-4 font-mono text-sm">
      {catalogState === "loading" ? <p role="status" className="border border-bone/50 px-4 py-5 text-bone/70 text-center">Загрузка списка</p> : null}
      {catalogState === "error" ? <p role="status" className="border border-bone/50 px-4 py-5 text-bone/70 text-center">Произошла ошибка. Перезагрузите страницу</p> : null}
      {catalogState === "ready" && !occurrences.length ? <p role="status" className="border border-bone/50 px-4 py-5 text-bone/70 text-center">Запись на ближайшие даты пока не открыта.</p> : null}
      {occurrences.map((occurrence) => <button key={occurrence.id} type="button" onClick={() => showBooking(occurrence)} className="flex w-full flex-col gap-4 border-2 border-bone/50 bg-bone px-4 py-5 text-left text-ink transition-colors hover:border-acid hover:bg-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid">
        <span className="font-display text-2xl">{occurrence.city_title} × {occurrenceDateLabel(occurrence.starts_at)}</span>
      </button>)}
      <button type="button" onClick={showCityInterest} className="flex w-full flex-col gap-4 border-2 border-bone/50 bg-bone px-4 py-5 text-left text-ink transition-colors hover:border-acid hover:bg-acid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid">
        <span className="font-display text-2xl">Твой город × Скоро</span>
      </button>
    </div>
  );

  if (!selected) return null;

  return (
    <>
    <form className="space-y-4 font-mono text-sm" onSubmit={submit}>
      <div className="grid gap-3 border border-acid/60 p-3">
        <div>
          <p className="text-xs text-bone/70">Дата и время</p>
          <p className="mt-1 font-display text-xl text-acid">{occurrenceDateTimeLabel(selected.starts_at, selected.timezone)}</p>
        </div>
        <div>
          <p className="text-xs text-bone/70">Место проведения</p>
          <p className="mt-1 leading-relaxed text-bone/90">{quote?.venue_disclosure ?? publicVenueDisclosure(selected)}</p>
        </div>
      </div>
      {!canCheckout ? <><p role="status" className="border border-bone/50 px-3 py-2 text-bone/70">{purchaseStatusAnnouncement(selected.purchase_status)}</p>{occurrenceNotificationsAvailable && selected.purchase_status !== "UNAVAILABLE" ? <OccurrenceNotifyForm occurrenceId={selected.id} onAlreadyAvailable={() => void refreshOccurrenceState(selected.id)} /> : null}</> : <>
      <label className="grid gap-1.5">Email <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>
      <fieldset className="grid gap-2 border border-bone/50 p-3">
        <legend className="px-1">Возрастная категория участника</legend>
        <label><input required type="radio" name="participant-age-band" checked={participantAgeBand === "ADULT"} onChange={() => setParticipantAgeBand("ADULT")} /> 18 лет или старше</label>
        <label><input required type="radio" name="participant-age-band" checked={participantAgeBand === "MINOR_14_17"} onChange={() => setParticipantAgeBand("MINOR_14_17")} /> 14–17 лет</label>
        <label><input required type="radio" name="participant-age-band" checked={participantAgeBand === "MINOR_UNDER_14"} onChange={() => setParticipantAgeBand("MINOR_UNDER_14")} /> младше 14 лет</label>
        {participantIsMinor ? <label><input required type="checkbox" checked={minorRepresentative} onChange={(event) => setMinorRepresentative(event.target.checked)} /> Я являюсь совершеннолетним законным представителем несовершеннолетнего участника, для которого оформляю этот заказ.</label> : null}
        {participantRequiresAdultAccompaniment ? <p role="status" className="text-bone/70">Участник, которому на момент оформления заказа не исполнилось 14 лет, посещает мастер-класс в сопровождении взрослого.</p> : null}
      </fieldset>
      <div className="grid gap-2 text-xs leading-snug">
        <label><input required type="checkbox" checked={customerAdult} onChange={(event) => setCustomerAdult(event.target.checked)} /> {participantAgeBand === "ADULT" ? "Мне исполнилось 18 лет. Я оформляю заказ от своего имени." : "Мне исполнилось 18 лет. Я оформляю заказ как совершеннолетнее лицо."}</label>
        <label><input required type="checkbox" checked={offer} onChange={(event) => setOffer(event.target.checked)} /> Я принимаю условия {quote ? <a className="text-acid underline underline-offset-4" href={legalPagePaths.PUBLIC_OFFER} target="_blank" rel="noopener noreferrer">{legalLabels.PUBLIC_OFFER}</a> : "публичной оферты"}.</label>
        <label><input required type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Я даю согласие на обработку моих персональных данных как Заказчика.</label>
        {quote && <p className="text-bone/70">Версия legal release {quote.legal_release.version}: {(Object.keys(legalLabels) as (keyof typeof legalLabels)[]).map((id, index) => <span key={id}>{index > 0 ? " · " : ""}<a className="text-acid underline underline-offset-4" href={legalPagePaths[id]} target="_blank" rel="noopener noreferrer">{legalLabels[id]}</a></span>)}</p>}
      </div>
      <p role="status" aria-live="polite" className={message ? "border border-acid px-3 py-2 text-acid" : "sr-only"}>{message ?? ""}</p>
      <label className="grid gap-1.5">Промокод <span className="flex gap-2"><input disabled={Boolean(appliedPromoCode)} value={appliedPromoCode ? `Промокод [${appliedPromoCode}] применен` : promoCode} onChange={(event) => setPromoCode(event.target.value)} className="min-w-0 flex-1 border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid disabled:cursor-not-allowed disabled:opacity-70" /><button type="button" disabled={loading} onClick={() => void (appliedPromoCode ? resetPromo() : applyPromo())} className="shrink-0 border border-acid px-3 py-2 font-display text-acid transition-colors hover:bg-acid hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid disabled:cursor-wait disabled:opacity-60">{appliedPromoCode ? "Сброс" : "Применить"}</button></span></label>
      {quote && <div className="grid gap-1 border border-acid/60 p-3 text-bone"><p>{selected?.city_title}</p><p>Исходная цена: {rub(quote.price_kopecks)}</p>{quote.discount_kopecks > 0 ? <p>Скидка{quote.promo ? ` (${quote.promo.code})` : ""}: −{rub(quote.discount_kopecks)}</p> : null}<p className="font-display text-lg text-acid">Итого: {rub(quote.final_amount_kopecks)}</p></div>}
      <button disabled={!quote || !participantAgeBand || submitting} className="w-full border-2 border-acid bg-acid px-4 py-3 font-display text-lg text-ink disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "Создаём оплату…" : "Перейти к оплате"}</button>
      </>}
    </form>
    </>
  );
}
