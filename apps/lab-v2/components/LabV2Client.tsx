"use client";
import { useEffect, useState } from "react";
import { commerceApiUrl } from "../../../lib/commerce-api";
import { labCatalogueSchema, labHistorySchema, labMeSchema, type LabCatalogue } from "../../../lib/lab-v2-contract";

type Order = ReturnType<typeof labHistorySchema.parse>["orders"][number];
const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(value / 100);

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(commerceApiUrl(path), { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("LAB_V2_READ_UNAVAILABLE");
  return response.json() as Promise<unknown>;
}

/** Separate V2 entrypoint: no legacy checkout, ticket token, notify or refund consumers. */
export default function LabV2Client() {
  const [catalogue, setCatalogue] = useState<LabCatalogue | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([read("/v1/lab/catalogue", controller.signal), read("/v1/me", controller.signal)])
      .then(async ([data, session]) => {
        const model = labCatalogueSchema.parse(data), me = labMeSchema.parse(session);
        const history = me.customer ? labHistorySchema.parse(await read("/v1/me/orders", controller.signal)).orders : [];
        if (controller.signal.aborted) return;
        setCatalogue(model);setEmail(me.customer?.email_normalized ?? null);setOrders(history.filter((order) => order.productKind === "LAB"));
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
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
    <section className="intro"><p className="eyebrow">Практика в движении</p><h1>Встречаемся.<br /><span>Двигаемся.</span></h1><p className="notice">Платежи, продажи и регистрация закрыты. Здесь отображаются только опубликованные данные Commerce V2.</p></section>
    {error ? <p role="alert">Не удалось проверить данные V2. Повторите загрузку. Устаревший API не используется.</p> : null}
    <section id="catalogue" aria-labelledby="catalogue-title"><div className="sectionHeading"><span>01 /</span><h2 id="catalogue-title">Расписание LAB</h2></div>
      {!catalogue ? <p role="status">Проверяем каталог…</p> : catalogue.occurrences.length === 0 ? <p className="empty">Опубликованных встреч пока нет.</p> : <div className="events">{catalogue.occurrences.map((event) => <article key={event.offerRef}>
        <p>{catalogue.cities.find((city) => city.cityId === event.cityId)?.title ?? "Город не указан"}</p><h3>{event.title}</h3>
        <time dateTime={event.startsAt}>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: event.timezone }).format(new Date(event.startsAt))}</time>
        <p>{money(event.amountKopecks)}</p><button disabled>Покупка закрыта</button>
      </article>)}</div>}
    </section>
    <section aria-labelledby="account-title"><div className="sectionHeading"><span>02 /</span><h2 id="account-title">Ваш аккаунт</h2></div>
      {email ? <><p>{email}</p><button onClick={logout} disabled={busy}>{busy ? "Выходим…" : "Выйти из аккаунта"}</button><h3>Заказы LAB</h3>{orders.length ? <ol>{orders.map((order) => <li key={order.orderPublicId + order.offerRef}><strong>{order.title}</strong><span>{order.state} · {money(order.amountKopecks)}</span></li>)}</ol> : <p className="empty">Заказов LAB пока нет.</p>}</>
        : <p className="empty">Вход и регистрация не открыты до утверждения юридических документов и проверки magic links.</p>}
    </section><footer>Без синтетического каталога. Без денежных операций.</footer>
  </main>;
}
