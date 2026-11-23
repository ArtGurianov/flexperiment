"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import LabGuestCheckout from "./LabGuestCheckout";
import { labRequest, newLabCapability } from "./LabGuestCheckout";
import { RefundContact } from "../../../packages/customer-support/RefundContact";
import { useEffect, useState } from "react";
import { commerceApiUrl } from "../../../lib/commerce-api";
import { labCatalogueSchema, labHistorySchema, labMeSchema, type LabCatalogue } from "../../../lib/lab-v2-contract";
import { labEventsJsonLd } from "./lab-json-ld";
import LabInterestForm from "./LabInterestForm";
import { labShowcaseSchema, type LabShowcase } from "../../../lib/lab-showcase-contract";

type Order = ReturnType<typeof labHistorySchema.parse>["orders"][number];
const closedReason: Record<NonNullable<LabShowcase["sales"]["reason"]>, string> = {
  PAYMENTS_DISABLED: "Продажа билетов LAB пока закрыта: оплата не подключена.",
  STOREFRONT_CLOSED: "Продажа билетов LAB сейчас закрыта.",
  OFFERS_CLOSED: "Продажи на эти встречи ещё не открыты.",
};
const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(value / 100);

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(commerceApiUrl(path), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("LAB_V2_READ_UNAVAILABLE");
  return response.json() as Promise<unknown>;
}

/** LAB V2 guest checkout; all authority stays in Commerce V2. */
export default function LabV2Client() {
  const router = useRouter();
  const [catalogue, setCatalogue] = useState<LabCatalogue | null>(null);
  const [showcase, setShowcase] = useState<LabShowcase | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const reportReadError = () => { if (!controller.signal.aborted) setError(true); };
    void read("/v1/lab/showcase", controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setShowcase(labShowcaseSchema.parse(data));
      }).catch(reportReadError);
    void read("/v1/lab/catalogue", controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setCatalogue(labCatalogueSchema.parse(data));
      }).catch(reportReadError);
    void read("/v1/me", controller.signal)
      .then(async (session) => {
        const me = labMeSchema.parse(session);
        const history = me.customer ? labHistorySchema.parse(await read("/v1/me/orders", controller.signal)).orders : [];
        if (controller.signal.aborted) return;
        setEmail(me.customer?.email_normalized ?? null);
        setOrders(history.filter((order) => order.productKind === "LAB"));
      }).catch(reportReadError);
    return () => controller.abort();
  }, []);
  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch(commerceApiUrl("/v1/auth/sign-out"), {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!response.ok) throw new Error("SESSION_REVOCATION_FAILED");
      setEmail(null);setOrders([]);
    } catch { setError(true); }
    finally { setBusy(false); }
  };
  return <main>
    <header><a href="#catalogue" className="wordmark">FLEXPERIMENT<span> / LAB</span></a><span className="stamp">PRIVATE CANARY · V2</span></header>
    <section className="intro"><p className="eyebrow">Практика в движении</p><h1>Встречаемся.<br /><span>Двигаемся.</span></h1><p className="notice">Афиша мастер-классов по городам.</p></section>
    {error ? <p role="alert">Не удалось проверить данные V2. Повторите загрузку. Устаревший API не используется.</p> : null}
    <section id="catalogue" aria-labelledby="catalogue-title"><div className="sectionHeading"><span>01 /</span><h2 id="catalogue-title">Расписание LAB</h2></div>
      {showcase?.sales.state === "CLOSED" ? <p className="salesStatus" role="status"><strong>Продажи закрыты.</strong> {closedReason[showcase.sales.reason ?? "STOREFRONT_CLOSED"]} Оставьте предзапись — сообщим, когда откроем.</p> : null}
      {!showcase ? <p role="status">Проверяем каталог…</p> : showcase.occurrences.length === 0 ? <p className="empty">Опубликованных встреч пока нет.</p> : <div className="events">{showcase.occurrences.map((event) => {
        const purchasable = catalogue?.occurrences.find((offer) => offer.occurrenceRef === event.occurrenceRef);
        return <article key={event.occurrenceRef} id={event.occurrenceRef}>
        <p>{showcase.cities.find((city) => city.cityId === event.cityId)?.title ?? "Город не указан"}</p><h3>{event.title}</h3>
        <time dateTime={event.startsAt}>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: event.timezone }).format(new Date(event.startsAt))}</time>
        <p>{event.venue.status === "CONFIRMED" ? [event.venue.name, event.venue.address].filter(Boolean).join(", ") || "Адрес сообщим участникам" : event.venue.disclosureText}</p>
        <p>{money(event.amountKopecks)}</p>{event.sales === "OPEN" && purchasable && !purchasable.soldOut && catalogue?.paymentMode !== "disabled"
          ? <LabGuestCheckout offerRef={purchasable.offerRef} displayedAmountKopecks={purchasable.amountKopecks} />
          : <button disabled>{purchasable?.soldOut ? "Мест нет" : "Продажи закрыты"}</button>}
      </article>; })}</div>}
      {catalogue?.occurrences.length ? <script type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(labEventsJsonLd(catalogue)).replace(/</g, "\\u003c") }} /> : null}
      {showcase?.sales.state === "CLOSED" ? <LabInterestForm interest={showcase.interest} cities={showcase.cities} /> : null}
    </section>
    <section aria-labelledby="account-title"><div className="sectionHeading"><span>02 /</span><h2 id="account-title">Ваш аккаунт</h2></div>
      {email ? <><p>{email}</p><button onClick={logout} disabled={busy}>{busy ? "Выходим…" : "Выйти из аккаунта"}</button><h3>Заказы LAB</h3>{orders.length ? <ol>{orders.map((order) => <li key={order.orderPublicId + order.offerRef}><strong>{order.title}</strong><span>{order.state} · {money(order.amountKopecks)}</span><button disabled={busy} onClick={async () => {
          setBusy(true); try { const accessToken = newLabCapability(); await labRequest("/v1/lab/guest/reissue", { orderPublicId: order.orderPublicId, accessToken });
            router.push(`/ticket#access=${accessToken}`); } catch { setError(true); } finally { setBusy(false); }
        }}>Открыть билет</button></li>)}</ol> : <p className="empty">Заказов LAB пока нет.</p>}</>
        : <p className="empty">Вход и регистрация не открыты до утверждения юридических документов и проверки magic links.</p>}
    </section><section><h2>Уже купили билет?</h2><Link href="/ticket">Открыть или восстановить билет по email</Link></section><RefundContact /><footer>Билеты и условия — по данным организатора LAB.</footer>
  </main>;
}
