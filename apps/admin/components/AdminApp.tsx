"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createLatestRequestGate } from "./latest-request";
import { occurrenceActionsFor } from "./occurrence-actions";

type Page = "dashboard" | "login" | "cities" | "occurrences" | "orders" | "refunds" | "audit";
type Row = Record<string, unknown>;

class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const nav: { href: string; page: Page; label: string; index: string }[] = [
  { href: "/", page: "dashboard", label: "Обзор", index: "01" },
  { href: "/cities/", page: "cities", label: "Города", index: "02" },
  { href: "/occurrences/", page: "occurrences", label: "События", index: "03" },
  { href: "/orders/", page: "orders", label: "Заказы", index: "04" },
  { href: "/refunds/", page: "refunds", label: "Возвраты", index: "05" },
  { href: "/audit/", page: "audit", label: "Аудит", index: "06" },
];

const idempotencyKey = () => crypto.randomUUID();
const string = (value: unknown) => typeof value === "string" ? value : "";
const number = (value: unknown) => typeof value === "number" ? value : Number(value ?? 0);
const formatMoney = (value: unknown) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(number(value) / 100);
const formatDate = (value: unknown) => {
  const date = new Date(string(value));
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const fromLocalInput = (value: string) => value ? new Date(value).toISOString() : "";
const toLocalInput = (value: unknown) => {
  const date = new Date(string(value));
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(`/v1/admin${path}`, { ...init, credentials: "same-origin", headers: { Accept: "application/json", ...init.headers } });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      throw new AdminApiError(response.status, body?.error?.code ?? `HTTP_${response.status}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(0, "NETWORK_AMBIGUOUS");
  }
}

function useResource<T>(path: string, active = true) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  const requestGate = useRef(createLatestRequestGate());
  const reload = useCallback(async () => {
    if (!active) { requestGate.current.invalidate(); setLoading(false); return; }
    const version = requestGate.current.begin();
    setLoading(true); setError(null);
    try {
      const next = await api<T>(path);
      if (requestGate.current.isLatest(version)) setValue(next);
    }
    catch (failure) {
      const issue = failure as AdminApiError;
      if (requestGate.current.isLatest(version)) setError(issue.code);
    } finally { if (requestGate.current.isLatest(version)) setLoading(false); }
  }, [active, path]);
  useEffect(() => {
    const gate = requestGate.current;
    void Promise.resolve().then(reload);
    return () => { gate.invalidate(); };
  }, [reload]);
  return { value, error, loading, reload };
}

function Badge({ children }: { children: ReactNode }) {
  const text = String(children ?? "—");
  const tone = /PAID|SUCCEEDED|PUBLISHED|OPEN|CONFIRMED|DELIVERED|AUTHENTICATED/.test(text) ? "good" : /UNKNOWN|REVIEW|FAILED|CANCELLED|ABANDONED|PAUSED/.test(text) ? "warn" : "neutral";
  return <span className={`badge badge-${tone}`}>{text}</span>;
}

function Notice({ error, children }: { error?: string | null; children?: ReactNode }) {
  if (!error && !children) return null;
  return <p className={`notice ${error ? "notice-error" : ""}`}>{error ? <>Ошибка: <code>{error}</code>{error === "NETWORK_AMBIGUOUS" && " — результат операции может быть неизвестен; не создавайте новую mutation, сначала перечитайте состояние."}</> : children}</p>;
}

function Loading() { return <p className="loading">Загружаем authoritative state…</p>; }

function Shell({ page, children, onLogout }: { page: Page; children: ReactNode; onLogout: () => void }) {
  return <div className="shell">
    <aside className="rail">
      <Link href="/" className="brand"><span>FX</span><strong>CONTROL<br />ROOM</strong></Link>
      <nav>{nav.map((item) => <Link className={item.page === page ? "nav-active" : ""} href={item.href} key={item.page}><em>{item.index}</em>{item.label}</Link>)}</nav>
      <button className="logout" onClick={onLogout}>Выйти из сессии <span>↗</span></button>
    </aside>
    <main className="content"><header className="topline"><span>admin.flexperiment.ru</span><span className="live-dot">LIVE DATA / NO CACHE</span></header>{children}</main>
  </div>;
}

function Login() {
  const router = useRouter();
  const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api<{ ok: true }>("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      router.replace("/");
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };
  return <main className="login-page"><section className="login-card"><p className="eyebrow">FLEXPERIMENT / AUTHORITY GATE</p><h1>Вход<br /><i>в control room.</i></h1><p>Сессия хранится только в защищённой HttpOnly cookie. Токены не попадают в браузерное хранилище.</p><form onSubmit={submit}><label>Пароль администратора<input autoFocus autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label><Notice error={error} /><button className="primary" disabled={busy}>{busy ? "Проверяем…" : "Войти"}</button></form></section></main>;
}

function Dashboard() {
  const data = useResource<{ today: Row; health: Record<string, Row>; upcoming: Row[] }>("/dashboard");
  if (data.loading) return <Loading />; if (!data.value) return <Notice error={data.error} />;
  const today = data.value.today;
  const health: [string, unknown][] = [
    ["CREATE_UNKNOWN", data.value.health.create_unknown?.count], ["REVIEW_REQUIRED", data.value.health.review_required?.count],
    ["Pending refunds", data.value.health.pending_refunds?.count], ["Email failures", data.value.health.email_failures?.count],
  ];
  return <><section className="hero"><p className="eyebrow">OPERATIONAL OVERVIEW / TODAY</p><h1>Данные без<br /><i>магии статусов.</i></h1><p>Commerce и SQLite остаются источником истины. Этот экран ничего не мутирует.</p></section>
    <section className="metrics"><Metric label="Заказы" value={number(today.orders)} /><Metric label="Получено" value={formatMoney(today.revenue_kopecks)} /><Metric label="Возвращено" value={formatMoney(today.refunded_kopecks)} /></section>
    <section className="two-col"><Panel title="Операционное внимание"><div className="signal-list">{health.map(([label, count]) => <div key={String(label)}><span>{label}</span><strong className={number(count) > 0 ? "signal-hot" : ""}>{number(count)}</strong></div>)}</div></Panel>
      <Panel title="Ближайшие события">{data.value.upcoming.length ? <div className="upcoming-list">{data.value.upcoming.map((item) => <div key={string(item.id)}><span>{string(item.city_title)}</span><strong>{string(item.title)}</strong><small>{formatDate(item.starts_at)} · {number(item.availability)} / {number(item.capacity)} мест</small><Badge>{string(item.sales_status)}</Badge></div>)}</div> : <Empty label="Нет запланированных событий." />}</Panel></section></>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function Panel({ title, children }: { title: string; children: ReactNode }) { return <section className="panel"><h2>{title}</h2>{children}</section>; }
function Empty({ label }: { label: string }) { return <p className="empty">{label}</p>; }

function Cities() {
  const data = useResource<{ cities: Row[] }>("/cities");
  const [name, setName] = useState(""); const [slug, setSlug] = useState(""); const [reason, setReason] = useState("");
  const [key, setKey] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const actionKey = key ?? idempotencyKey(); setKey(actionKey); setBusy(true); setError(null);
    try {
      await api("/cities", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": actionKey }, body: JSON.stringify({ name, slug, reason }) });
      setName(""); setSlug(""); setReason(""); setKey(null); await data.reload();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };
  return <><PageTitle eyebrow="CATALOG / GEOGRAPHY" title={<>Города<br /><i>тура.</i></>} text="Создание — audited command с сохранённым idempotency key. Город сам по себе не появляется в public catalog." />
    <section className="two-col catalog-grid"><Panel title="Существующие города">{data.loading ? <Loading /> : data.value ? <table><thead><tr><th>Город</th><th>Slug</th><th>События</th></tr></thead><tbody>{data.value.cities.map((city) => <tr key={string(city.id)}><td><strong>{string(city.title)}</strong><small>{string(city.id)}</small></td><td><code>{string(city.slug)}</code></td><td>{number(city.occurrence_count)}</td></tr>)}</tbody></table> : <Notice error={data.error} />}</Panel>
      <Panel title="Добавить город"><form className="form" onSubmit={submit}><label>Название<input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></label><label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required pattern="[a-z0-9-]{2,100}" /></label><label>Причина / audit context<textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} /></label><Notice error={error} /><button className="primary" disabled={busy}>{busy ? "Создаём…" : "Создать город"}</button></form></Panel></section></>;
}

function Occurrences() {
  const cities = useResource<{ cities: Row[] }>("/cities"); const occurrences = useResource<{ occurrences: Row[] }>("/occurrences");
  const [form, setForm] = useState({ city_id: "", title: "", starts_at: "", ends_at: "", timezone: "Asia/Novosibirsk", price_kopecks: "", capacity: "", venue_status: "CONFIRMED", venue_name: "", venue_address: "", venue_disclosure_text: "", venue_announce_by: "", reason: "" });
  const [key, setKey] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [action, setAction] = useState<{ occurrence: Row; patch: Row } | null>(null); const [editing, setEditing] = useState<Row | null>(null);
  const set = (field: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [field]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.venue_status === "TO_BE_ANNOUNCED" && new Date(form.venue_announce_by).getTime() >= new Date(form.starts_at).getTime()) { setError("VENUE_ANNOUNCEMENT_TOO_LATE"); return; }
    const actionKey = key ?? idempotencyKey(); setKey(actionKey); setBusy(true); setError(null);
    const body: Row = { city_id: form.city_id || string(cities.value?.cities[0]?.id), title: form.title, starts_at: fromLocalInput(form.starts_at), ends_at: fromLocalInput(form.ends_at), timezone: form.timezone, price_kopecks: Number(form.price_kopecks), capacity: Number(form.capacity), venue_status: form.venue_status, reason: form.reason };
    if (form.venue_status === "CONFIRMED") { body.venue_name = form.venue_name; body.venue_address = form.venue_address; }
    else { body.venue_disclosure_text = form.venue_disclosure_text; body.venue_announce_by = fromLocalInput(form.venue_announce_by); }
    try { await api("/occurrences", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": actionKey }, body: JSON.stringify(body) }); setKey(null); setForm((previous) => ({ ...previous, title: "", starts_at: "", ends_at: "", price_kopecks: "", capacity: "", venue_name: "", venue_address: "", venue_disclosure_text: "", venue_announce_by: "", reason: "" })); await occurrences.reload(); }
    catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };
  return <><PageTitle eyebrow="CATALOG / OCCURRENCES" title={<>События<br /><i>без опасных shortcut.</i></>} text="Новая occurrence всегда создаётся HIDDEN + CLOSED. Публикация и продажи — отдельные audited действия." />
    <section className="panel"><h2>Создать событие</h2><form className="form form-grid" onSubmit={submit}><label>Город<select value={form.city_id || string(cities.value?.cities[0]?.id)} onChange={(event) => set("city_id", event.target.value)} required>{cities.value?.cities.map((city) => <option key={string(city.id)} value={string(city.id)}>{string(city.title)}</option>)}</select></label><label>Название<input value={form.title} onChange={(event) => set("title", event.target.value)} required /></label><label>Начало<input type="datetime-local" value={form.starts_at} onChange={(event) => set("starts_at", event.target.value)} required /></label><label>Конец<input type="datetime-local" value={form.ends_at} onChange={(event) => set("ends_at", event.target.value)} required /></label><label>Timezone<input value={form.timezone} onChange={(event) => set("timezone", event.target.value)} required /></label><label>Цена, копейки<input type="number" min="1" step="1" value={form.price_kopecks} onChange={(event) => set("price_kopecks", event.target.value)} required /></label><label>Вместимость<input type="number" min="1" step="1" value={form.capacity} onChange={(event) => set("capacity", event.target.value)} required /></label><label>Площадка<select value={form.venue_status} onChange={(event) => set("venue_status", event.target.value)}><option value="CONFIRMED">Подтверждена</option><option value="TO_BE_ANNOUNCED">Будет объявлена</option></select></label>{form.venue_status === "CONFIRMED" ? <><label>Название площадки<input value={form.venue_name} onChange={(event) => set("venue_name", event.target.value)} required /></label><label>Адрес<textarea value={form.venue_address} onChange={(event) => set("venue_address", event.target.value)} required /></label></> : <><label>Disclosure<textarea value={form.venue_disclosure_text} onChange={(event) => set("venue_disclosure_text", event.target.value)} required /></label><label>Объявить до<input type="datetime-local" value={form.venue_announce_by} onChange={(event) => set("venue_announce_by", event.target.value)} required /></label></>}<label className="wide">Причина / audit context<textarea value={form.reason} onChange={(event) => set("reason", event.target.value)} required minLength={3} /></label><div className="wide"><Notice error={error} /><button className="primary" disabled={busy}>{busy ? "Создаём…" : "Создать скрытое событие"}</button></div></form></section>
    <section className="panel"><h2>Все состояния каталога</h2>{occurrences.loading ? <Loading /> : occurrences.value ? <div className="occurrence-list">{occurrences.value.occurrences.map((occurrence) => <OccurrenceRow key={string(occurrence.id)} occurrence={occurrence} onAction={setAction} onEdit={setEditing} />)}</div> : <Notice error={occurrences.error} />}</section>
    {action && <OccurrenceAction action={action} close={() => setAction(null)} done={async () => { await occurrences.reload(); setAction(null); }} />}
    {editing && <OccurrenceEditor occurrence={editing} close={() => setEditing(null)} done={async () => { await occurrences.reload(); setEditing(null); }} />}</>;
}

function OccurrenceRow({ occurrence, onAction, onEdit }: { occurrence: Row; onAction: (next: { occurrence: Row; patch: Row }) => void; onEdit: (occurrence: Row) => void }) {
  const actions = occurrenceActionsFor(occurrence);
  return <article className="occurrence-row"><div><p className="eyebrow">{string(occurrence.city_title)} / {string(occurrence.city_slug)}</p><h3>{string(occurrence.title)}</h3><p>{formatDate(occurrence.starts_at)} · {formatMoney(occurrence.price_kopecks)} · {number(occurrence.availability)} / {number(occurrence.capacity)} мест</p><code>{string(occurrence.id)}</code></div><div className="state-stack"><Badge>{string(occurrence.visibility)}</Badge><Badge>{string(occurrence.sales_status)}</Badge><Badge>{string(occurrence.fulfillment_status)}</Badge></div><div className="action-stack"><button onClick={() => onEdit(occurrence)}>Редактировать</button>{actions.map((action) => <button key={action.label} onClick={() => onAction({ occurrence, patch: action.patch })}>{action.label}</button>)}</div></article>;
}

function OccurrenceEditor({ occurrence, close, done }: { occurrence: Row; close: () => void; done: () => Promise<void> }) {
  const [form, setForm] = useState({ title: string(occurrence.title), starts_at: toLocalInput(occurrence.starts_at), ends_at: toLocalInput(occurrence.ends_at), timezone: string(occurrence.timezone), price_kopecks: String(number(occurrence.price_kopecks)), capacity: String(number(occurrence.capacity)), venue_status: string(occurrence.venue_status), venue_name: string(occurrence.venue_name), venue_address: string(occurrence.venue_address), venue_disclosure_text: string(occurrence.venue_disclosure_text), venue_announce_by: toLocalInput(occurrence.venue_announce_by), reason: "" });
  const [key] = useState(idempotencyKey); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (field: keyof typeof form, value: string) => setForm((previous) => ({ ...previous, [field]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.venue_status === "TO_BE_ANNOUNCED" && new Date(form.venue_announce_by).getTime() >= new Date(form.starts_at).getTime()) { setError("VENUE_ANNOUNCEMENT_TOO_LATE"); return; }
    const body: Row = { title: form.title, starts_at: fromLocalInput(form.starts_at), ends_at: fromLocalInput(form.ends_at), timezone: form.timezone, price_kopecks: Number(form.price_kopecks), capacity: Number(form.capacity), venue_status: form.venue_status, reason: form.reason };
    if (form.venue_status === "CONFIRMED") { body.venue_name = form.venue_name; body.venue_address = form.venue_address; body.venue_disclosure_text = null; body.venue_announce_by = null; }
    else { body.venue_name = null; body.venue_address = null; body.venue_disclosure_text = form.venue_disclosure_text; body.venue_announce_by = fromLocalInput(form.venue_announce_by); }
    setBusy(true); setError(null);
    try { await api(`/occurrences/${string(occurrence.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }); await done(); }
    catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="modal editor" onSubmit={submit}><p className="eyebrow">CATALOG / MATERIAL EDIT</p><h2>Редактировать событие</h2><div className="form form-grid"><label>Название<input value={form.title} onChange={(event) => set("title", event.target.value)} required /></label><label>Timezone<input value={form.timezone} onChange={(event) => set("timezone", event.target.value)} required /></label><label>Начало<input type="datetime-local" value={form.starts_at} onChange={(event) => set("starts_at", event.target.value)} required /></label><label>Конец<input type="datetime-local" value={form.ends_at} onChange={(event) => set("ends_at", event.target.value)} required /></label><label>Цена, копейки<input type="number" min="0" value={form.price_kopecks} onChange={(event) => set("price_kopecks", event.target.value)} required /></label><label>Вместимость<input type="number" min="0" value={form.capacity} onChange={(event) => set("capacity", event.target.value)} required /></label><label className="wide">Площадка<select value={form.venue_status} onChange={(event) => set("venue_status", event.target.value)}><option value="CONFIRMED">Подтверждена</option><option value="TO_BE_ANNOUNCED">Будет объявлена</option></select></label>{form.venue_status === "CONFIRMED" ? <><label>Название площадки<input value={form.venue_name} onChange={(event) => set("venue_name", event.target.value)} required /></label><label>Адрес<textarea value={form.venue_address} onChange={(event) => set("venue_address", event.target.value)} required /></label></> : <><label>Disclosure<textarea value={form.venue_disclosure_text} onChange={(event) => set("venue_disclosure_text", event.target.value)} required /></label><label>Объявить до<input type="datetime-local" value={form.venue_announce_by} onChange={(event) => set("venue_announce_by", event.target.value)} required /></label></>}<label className="wide">Причина изменения<textarea value={form.reason} onChange={(event) => set("reason", event.target.value)} minLength={3} required /></label></div><Notice error={error} /><div className="modal-actions"><button type="button" onClick={close}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить изменения"}</button></div></form></div>;
}

function OccurrenceAction({ action, close, done }: { action: { occurrence: Row; patch: Row }; close: () => void; done: () => Promise<void> }) {
  const [reason, setReason] = useState(""); const [key] = useState(idempotencyKey); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await api(`/occurrences/${string(action.occurrence.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ ...action.patch, reason }) }); await done(); } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); } };
  return <div className="modal-backdrop" role="presentation"><form className="modal" onSubmit={submit}><p className="eyebrow">EXPLICIT CATALOG ACTION</p><h2>{Object.values(action.patch).join(" ")}</h2><p>{string(action.occurrence.title)}</p><label>Причина<textarea autoFocus required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label><Notice error={error} /><div className="modal-actions"><button type="button" onClick={close}>Отмена</button><button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Подтвердить"}</button></div></form></div>;
}

function Orders() {
  const cities = useResource<{ cities: Row[] }>("/cities"); const occurrences = useResource<{ occurrences: Row[] }>("/occurrences");
  const [filters, setFilters] = useState({ city_id: "", occurrence_id: "", payment_status: "", booking_status: "" });
  const params = useMemo(() => Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&"), [filters]);
  const orders = useResource<{ orders: Row[] }>(`/orders${params ? `?${params}` : ""}`); const [selected, setSelected] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id"));
  return <><PageTitle eyebrow="COMMERCE / ORDERS" title={<>Заказы<br /><i>и их evidence.</i></>} text="Payment, booking, ticket, email и refund остаются отдельными фактами. Экран не сворачивает их в одну фиктивную метку." />
    <section className="panel"><div className="filters"><label>Город<select value={filters.city_id} onChange={(event) => setFilters((previous) => ({ ...previous, city_id: event.target.value }))}><option value="">Все</option>{cities.value?.cities.map((city) => <option key={string(city.id)} value={string(city.id)}>{string(city.title)}</option>)}</select></label><label>Событие<select value={filters.occurrence_id} onChange={(event) => setFilters((previous) => ({ ...previous, occurrence_id: event.target.value }))}><option value="">Все</option>{occurrences.value?.occurrences.map((occurrence) => <option key={string(occurrence.id)} value={string(occurrence.id)}>{string(occurrence.title)}</option>)}</select></label><label>Payment<select value={filters.payment_status} onChange={(event) => setFilters((previous) => ({ ...previous, payment_status: event.target.value }))}><option value="">Все</option>{["PENDING", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "REVIEW_REQUIRED"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Booking<select value={filters.booking_status} onChange={(event) => setFilters((previous) => ({ ...previous, booking_status: event.target.value }))}><option value="">Все</option>{["RESERVED", "CONFIRMED", "CANCELLED"].map((value) => <option key={value}>{value}</option>)}</select></label></div>{orders.loading ? <Loading /> : orders.value ? <table><thead><tr><th>Дата</th><th>Заказ</th><th>Событие</th><th>Покупатель</th><th>Сумма</th><th>Состояния</th></tr></thead><tbody>{orders.value.orders.map((order) => <tr className="click-row" onClick={() => { setSelected(string(order.id)); history.replaceState(null, "", `/orders/?id=${encodeURIComponent(string(order.id))}`); }} key={string(order.id)}><td>{formatDate(order.created_at)}</td><td><strong>{string(order.public_status_id).slice(0, 11)}…</strong><small>{string(order.id)}</small></td><td>{string(order.city_title)}<small>{string(order.occurrence_title)}</small></td><td>{string(order.customer_name)}<small>{string(order.customer_email)}</small></td><td>{formatMoney(order.amount_kopecks)}</td><td><Badge>{string(order.payment_state)}</Badge><Badge>{string(order.payment_status)}</Badge><Badge>{string(order.booking_status)}</Badge></td></tr>)}</tbody></table> : <Notice error={orders.error} />}</section>{selected && <OrderEvidence id={selected} close={() => { setSelected(null); history.replaceState(null, "", "/orders/"); }} />}</>;
}

function OrderEvidence({ id, close }: { id: string; close: () => void }) {
  const evidence = useResource<Row>(`/orders/${id}/evidence`); const [showRefund, setShowRefund] = useState(false); const [showAbandon, setShowAbandon] = useState(false);
  if (evidence.loading) return <section className="panel detail"><Loading /></section>; if (!evidence.value) return <section className="panel detail"><Notice error={evidence.error} /></section>;
  const data = evidence.value; const actions = data.actions as Row | undefined;
  return <section className="panel detail"><div className="detail-head"><h2>Order evidence</h2><button onClick={close}>Закрыть ×</button></div><code>{id}</code><div className="evidence-grid"><EvidenceCard title="ORDER" data={data.order} /><EvidenceCard title="PAYMENT" data={data.payment} /><EvidenceCard title="BOOKING" data={data.booking} /><EvidenceCard title="TICKET" data={data.ticket} /><EvidenceCard title="EMAIL" data={data.email_outbox} /><EvidenceCard title="REFUNDS" data={data.refunds} /><EvidenceCard title="RESERVATION RECOVERY" data={data.reservation_abandonment} /></div><div className="detail-actions">{actions?.can_create_compensation_refund === true && <button className="primary" onClick={() => setShowRefund(true)}>Вернуть оплату</button>}{actions?.can_abandon_reservation === true && <button className="danger" onClick={() => setShowAbandon(true)}>Technical abandonment</button>}</div>{showRefund && <RefundAction orderId={id} max={number((data.payment as Row | null)?.captured_amount_kopecks)} close={() => setShowRefund(false)} done={evidence.reload} />}{showAbandon && <AbandonAction orderId={id} close={() => setShowAbandon(false)} done={evidence.reload} />}</section>;
}

function EvidenceCard({ title, data }: { title: string; data: unknown }) { return <article className="evidence"><h3>{title}</h3><pre>{JSON.stringify(data, null, 2)}</pre></article>; }

function RefundAction({ orderId, max, close, done }: { orderId: string; max: number; close: () => void; done: () => Promise<void> }) {
  const [amount, setAmount] = useState(String(max)); const [reason, setReason] = useState(""); const [note, setNote] = useState(""); const [key] = useState(idempotencyKey); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await api(`/orders/${orderId}/refunds`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ amount_kopecks: Number(amount), reason, note: note || undefined }) }); await done(); close(); } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); } };
  return <ActionModal title="Компенсационный возврат" close={close}><form className="form" onSubmit={submit}><label>Сумма, копейки<input type="number" min="1" max={max} value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><label>Причина<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} required /></label><label>Комментарий<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label><Notice error={error} /><button className="primary" disabled={busy}>{busy ? "Создаём…" : "Создать refund"}</button></form></ActionModal>;
}

function AbandonAction({ orderId, close, done }: { orderId: string; close: () => void; done: () => Promise<void> }) {
  const [reason, setReason] = useState(""); const [key] = useState(idempotencyKey); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(null); try { await api(`/orders/${orderId}/abandon-reservation`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ reason }) }); await done(); close(); } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); } };
  return <ActionModal title="Technical reservation abandonment" close={close}><p>Команда доступна только потому, что backend сейчас явно считает эту reservation abandonable. Поздняя успешная оплата не восстановит booking.</p><form className="form" onSubmit={submit}><label>Причина<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} required /></label><Notice error={error} /><button className="danger" disabled={busy}>{busy ? "Выполняем…" : "Подтвердить abandonment"}</button></form></ActionModal>;
}

function ActionModal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) { return <div className="modal-backdrop"><section className="modal"><p className="eyebrow">FINANCIAL / EXPLICIT COMMAND</p><h2>{title}</h2>{children}<button className="modal-close" onClick={close}>Отмена</button></section></div>; }

function Refunds() {
  const data = useResource<{ refunds: Row[] }>("/refunds");
  return <><PageTitle eyebrow="COMMERCE / REFUNDS" title={<>Возвраты<br /><i>без blind retry.</i></>} text="Состояние provider и внутренний state отображаются как факты. Новую операцию создают только из допустимого order evidence." />
    <section className="panel">{data.loading ? <Loading /> : data.value ? <table><thead><tr><th>Создан</th><th>Заказ</th><th>Событие</th><th>Сумма</th><th>Источник</th><th>Статус</th></tr></thead><tbody>{data.value.refunds.map((refund) => <tr key={string(refund.id)}><td>{formatDate(refund.created_at)}</td><td><strong>{string(refund.public_status_id).slice(0, 11)}…</strong><small>{string(refund.order_id)}</small></td><td>{string(refund.city_title)}<small>{string(refund.occurrence_title)}</small></td><td>{formatMoney(refund.amount_kopecks)}</td><td><Badge>{string(refund.source)}</Badge></td><td><Badge>{string(refund.status)}</Badge></td></tr>)}</tbody></table> : <Notice error={data.error} />}</section></>;
}

function Audit() {
  const data = useResource<{ events: Row[] }>("/audit");
  return <><PageTitle eyebrow="AUTHORITY / AUDIT" title={<>Команды<br /><i>с контекстом.</i></>} text="Показываются durable записи Admin mutations. Секреты и capability здесь не выводятся." />
    <section className="panel">{data.loading ? <Loading /> : data.value ? <table><thead><tr><th>Время</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>{data.value.events.map((event) => <tr key={string(event.id)}><td>{formatDate(event.created_at)}</td><td><Badge>{string(event.action)}</Badge></td><td>{string(event.entity_type)}<small>{string(event.entity_id)}</small></td><td><code>{string(event.details_json)}</code></td></tr>)}</tbody></table> : <Notice error={data.error} />}</section></>;
}

function PageTitle({ eyebrow, title, text }: { eyebrow: string; title: ReactNode; text: string }) { return <section className="hero compact"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{text}</p></section>; }

export function AdminApp({ page }: { page: Page }) {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => { void api<{ authenticated: boolean }>("/session").then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => { if (authenticated === false) router.replace("/login/"); }, [authenticated, router]);
  const logout = async () => { await api("/logout", { method: "POST" }).catch(() => undefined); router.replace("/login/"); };
  if (page === "login") return <Login />;
  if (authenticated === null) return <main className="boot"><Loading /></main>;
  if (!authenticated) return <main className="boot"><Loading /></main>;
  const view = page === "dashboard" ? <Dashboard /> : page === "cities" ? <Cities /> : page === "occurrences" ? <Occurrences /> : page === "orders" ? <Orders /> : page === "refunds" ? <Refunds /> : <Audit />;
  return <Shell page={page} onLogout={logout}>{view}</Shell>;
}
