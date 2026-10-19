"use client";

import { LabCheckIn } from "./LabCheckIn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, AdminApiError, idempotencyKey } from "../../lib/api";
import type {
  AttentionResponse,
  AuditResponse,
  CatalogueResponse,
  CitiesResponse,
  ControlRoomIntegrationSummary,
  ControlRoomRefundCase,
  CustomersResponse,
  EntitlementsResponse,
  EmailOperationsResponse,
  IncidentsResponse,
  LabOccurrencesResponse,
  MerchantPromotionCommand,
  MerchantPromotionsResponse,
  ManualEntitlementGrantCommand,
  ManualEntitlementRevocationCommand,
  OrdersResponse,
  ProductConfigurationCommand,
  ProductWithdrawalCommand,
  RefundCasesResponse,
  RefundDecisionCommand,
  RefundEmailRegistrationCommand,
} from "../../lib/control-room-contracts";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Panel } from "../ui/Panel";
import { LessonVideoUpload } from "./LessonVideoUpload";
import { EditorialCourseEditor } from "./EditorialCourseEditor";
import { commercialTermsCommand, commercialTermsDraft, CommercialTermsFields } from "./CommercialTermsFields";
import { CityEditor, LabOccurrenceEditor } from "./LabOccurrenceEditor";

const useControlRoomQuery = <T,>(key: string, path: string) => useQuery({
  queryKey: ["control-room-v2", key],
  queryFn: () => api<T>(`/v2${path}`),
  refetchInterval: 30_000,
});

const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(kopecks / 100);
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

function QueryState({ error, empty, children }: { error: unknown; empty: boolean; children: React.ReactNode }) {
  if (error) return <Notice error={error instanceof AdminApiError ? error.code : "CONTROL_ROOM_READ_FAILED"} />;
  if (empty) return <p className="empty">Записей пока нет.</p>;
  return children;
}

function readError(error: unknown) {
  return error ? <Notice error={error instanceof AdminApiError ? error.code : "CONTROL_ROOM_READ_FAILED"} /> : null;
}

export function ControlRoomDashboard() {
  const integration = useControlRoomQuery<ControlRoomIntegrationSummary>("integration", "/integration");
  const catalogue = useControlRoomQuery<CatalogueResponse>("catalogue", "/catalogue");
  const orders = useControlRoomQuery<OrdersResponse>("orders", "/orders");
  const attention = useControlRoomQuery<AttentionResponse>("attention", "/attention");
  const error = integration.error ?? catalogue.error ?? orders.error ?? attention.error;
  if (error) return readError(error);
  if (!integration.data || !catalogue.data || !orders.data || !attention.data) return <Loading />;
  const openOrders = orders.data.orders.filter((order) => !["REFUNDED", "CANCELLED", "EXPIRED"].includes(order.state));
  return <>
    <PageTitle eyebrow="V2 / MERCHANT AUTHORITY" title={<>Коммерция<br /><i>без догадок.</i></>} text="Короткая оперативная картина: продажи, незавершённые внешние эффекты и места, где системе нужен человек." />
    <section className="metrics metrics-four">
      <article className="metric"><span>PAYMENT MODE</span><strong>{integration.data.paymentMode}</strong></article>
      <article className="metric"><span>КУРСОВ В КАТАЛОГЕ</span><strong>{catalogue.data.courses.length}</strong></article>
      <article className="metric"><span>АКТИВНЫХ ЗАКАЗОВ</span><strong>{openOrders.length}</strong></article>
      <article className="metric"><span>ТРЕБУЮТ ВНИМАНИЯ</span><strong className={attention.data.items.length ? "signal-hot" : ""}>{attention.data.items.length}</strong></article>
    </section>
    <section className="two-col">
      <Panel title="Внешние эффекты">
        <div className="signal-list">
          <div className="signal-row"><span>Незавершённые checkout</span><strong>{integration.data.outstandingCheckoutCount}</strong></div>
          <div className="signal-row"><span>Возвраты в обработке</span><strong>{integration.data.processingRefundCount}</strong></div>
          <div className="signal-row"><span>Устаревшие проекции</span><strong>{integration.data.staleProjectionCount}</strong></div>
          <div className="signal-row"><span>Playback denied / 24ч</span><strong className={integration.data.playbackAccess24h.denied ? "signal-hot" : ""}>{integration.data.playbackAccess24h.denied}</strong></div>
          <div className="signal-row"><span>Rate limited / 24ч</span><strong className={integration.data.playbackAccess24h.rateLimited ? "signal-hot" : ""}>{integration.data.playbackAccess24h.rateLimited}</strong></div>
          <div className="signal-row"><span>Invalid token / 24ч</span><strong className={integration.data.playbackAccess24h.invalidToken ? "signal-hot" : ""}>{integration.data.playbackAccess24h.invalidToken}</strong></div>
        </div>
      </Panel>
      <Panel title="Последняя принятая оплата">
        {integration.data.lastAcceptedPayment ? <div className="evidence v2-evidence">
          <p>{integration.data.lastAcceptedPayment.orderPublicId}</p>
          <small>{integration.data.lastAcceptedPayment.refrefAttemptId}</small>
          <small>{dateTime(integration.data.lastAcceptedPayment.observedAt)}</small>
        </div> : <p className="empty">Принятых оплат ещё нет.</p>}
      </Panel>
    </section>
  </>;
}

function CourseEditor({ course }: { course: CatalogueResponse["courses"][number] | null }) {
  const client = useQueryClient();
  const [productRef, setProductRef] = useState(course?.productRef ?? "course:");
  const [courseRef, setCourseRef] = useState(course?.courseRef ?? "");
  const [offerRef, setOfferRef] = useState(course?.offer?.offerRef ?? "course:");
  const [accessModel, setAccessModel] = useState<"FREE" | "PAID">(course?.accessModel ?? "FREE");
  const [terms, setTerms] = useState(() => commercialTermsDraft(course?.offer));
  const save = useMutation({
    mutationFn: (command: ProductConfigurationCommand) => api("/v2/catalogue/products", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["control-room-v2", "catalogue"] }),
  });
  const [reason, setReason] = useState("");
  const [termsRef, setTermsRef] = useState("");
  const withdraw = useMutation({
    mutationFn: (command: ProductWithdrawalCommand) => api(`/v2/catalogue/products/${encodeURIComponent(productRef)}/withdraw`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["control-room-v2", "catalogue"] }),
  });
  return <div className="catalogue-editor">
    <form className="refund-decision" onSubmit={(event) => {
      event.preventDefault();
      save.mutate({ productRef, courseRef, offerRef, kind: "ONLINE_COURSE", accessModel,
        ...commercialTermsCommand(terms), expectedVersion: course?.version ?? 0 });
    }}>
      <label>Product ref<input required disabled={Boolean(course)} value={productRef} onChange={(event) => setProductRef(event.target.value)} /></label>
      <label>Course ref<input required disabled={Boolean(course)} value={courseRef} onChange={(event) => setCourseRef(event.target.value)} /></label>
      <label>Offer ref<input required value={offerRef} onChange={(event) => setOfferRef(event.target.value)} /></label>
      <label>Модель доступа<select value={accessModel} onChange={(event) => setAccessModel(event.target.value as "FREE" | "PAID")}><option value="FREE">FREE</option><option value="PAID">PAID</option></select></label>
      <CommercialTermsFields value={terms} onChange={setTerms} paid={accessModel === "PAID"} />
      {save.error ? <Notice error={(save.error as AdminApiError).code} /> : null}
      <button className="primary" disabled={save.isPending || course?.withdrawn}>{save.isPending ? "Сохраняем…" : `Сохранить v${(course?.version ?? 0) + 1}`}</button>
    </form>
    {course && !course.withdrawn ? <form className="refund-decision withdrawal" onSubmit={(event) => {
      event.preventDefault();
      withdraw.mutate({ reason, termsRef, expectedVersion: course.version });
    }}>
      <label>Причина withdrawal<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <label>Ссылка на условия<input required value={termsRef} onChange={(event) => setTermsRef(event.target.value)} placeholder="offer/2026-09#withdrawal" /></label>
      {withdraw.error ? <Notice error={(withdraw.error as AdminApiError).code} /> : null}
      <button className="danger" disabled={withdraw.isPending}>Отозвать продукт</button>
    </form> : null}
  </div>;
}

export function CourseCatalogue() {
  const query = useControlRoomQuery<CatalogueResponse>("catalogue", "/catalogue");
  const initialCourseRef = useSearchParams()?.get("courseRef") ?? undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const linkedProductRef = initialCourseRef
    ? query.data?.courses.find((course) => course.courseRef === initialCourseRef)?.productRef
    : undefined;
  const effectiveSelected = selected ?? linkedProductRef ?? null;
  const selectedCourse = query.data?.courses.find((course) => course.productRef === effectiveSelected) ?? null;
  return <>
    <PageTitle eyebrow="КАТАЛОГ / КУРСЫ" title={<>Редакция отдельно.<br /><i>Продажа отдельно.</i></>} text="Commerce V2 хранит опубликованное содержание и коммерческое состояние курса. Продажи остаются закрытыми до отдельного решения." />
    <Panel title="Коммерческое состояние курсов">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.courses.length}>
        <table><thead><tr><th>Курс</th><th>Доступ</th><th>Оффер</th><th>Публикация</th><th>Сверка</th></tr></thead><tbody>
          {query.data.courses.map((course) => <tr key={course.courseRef}>
            <td><strong>{course.courseRef}</strong><small>{course.productRef} · v{course.version}</small>{course.withdrawn ? <Badge>WITHDRAWN</Badge> : null}</td>
            <td><Badge>{course.accessModel}</Badge></td>
            <td>{course.offer ? <><strong>{money(course.offer.priceKopecks)}</strong><Badge>{course.offer.saleMode}</Badge></> : <span>—</span>}</td>
            <td><Badge>{course.projection?.visibility ?? "NO PROJECTION"}</Badge><small>v{course.projection?.version ?? "—"}</small></td>
            <td><small>{dateTime(course.projection?.lastReconciledAt ?? null)}</small><button onClick={() => setSelected(course.productRef)}>Изменить</button></td>
          </tr>)}
        </tbody></table>
      </QueryState>}
      <button onClick={() => setSelected("__new__")}>Добавить коммерческий курс</button>
    </Panel>
    {effectiveSelected ? <Panel title={effectiveSelected === "__new__" ? "Новый продукт" : "Коммерческая команда"}>
      <CourseEditor key={effectiveSelected === "__new__" ? "new" : `${selectedCourse?.productRef}:${selectedCourse?.version}`} course={selectedCourse} />
    </Panel> : null}
    {query.data ? <Panel title="Редакция курса"><EditorialCourseEditor courses={query.data.courses} /></Panel> : null}
    {query.data ? <Panel title="Видео урока"><LessonVideoUpload courses={query.data.courses} /></Panel> : null}
  </>;
}

function PromotionEditor({ item }: { item: MerchantPromotionsResponse["promotions"][number] | null }) {
  const client = useQueryClient();
  const [code, setCode] = useState(item?.code ?? "");
  const [discountKind, setDiscountKind] = useState<"FIXED" | "PERCENT_BPS">(item?.discountKind ?? "FIXED");
  const [discountValue, setDiscountValue] = useState(String(item?.discountValue ?? ""));
  const [eligibleOfferRef, setEligibleOfferRef] = useState(item?.eligibleOfferRef ?? "");
  const [startsAt, setStartsAt] = useState(item?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(item?.endsAt ?? "");
  const [active, setActive] = useState(item?.active ?? true);
  const save = useMutation({
    mutationFn: (command: MerchantPromotionCommand) => api("/v2/promotions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["control-room-v2", "promotions"] }),
  });
  return <form className="refund-decision" onSubmit={(event) => {
    event.preventDefault();
    save.mutate({ ...(item ? { id: item.id } : {}), code, discountKind, discountValue: Number(discountValue),
      eligibleOfferRef: eligibleOfferRef || null, startsAt: startsAt || null, endsAt: endsAt || null,
      active, expectedVersion: item?.version ?? 0 });
  }}>
    <label>Код<input required value={code} onChange={(event) => setCode(event.target.value)} /></label>
    <label>Тип<select value={discountKind} onChange={(event) => setDiscountKind(event.target.value as typeof discountKind)}><option value="FIXED">FIXED</option><option value="PERCENT_BPS">PERCENT_BPS</option></select></label>
    <label>Значение<input required inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} /></label>
    <label>Только offer<input value={eligibleOfferRef} onChange={(event) => setEligibleOfferRef(event.target.value)} /></label>
    <label>Начало (ISO)<input value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
    <label>Окончание (ISO)<input value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
    <label><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Активен</label>
    {save.error ? <Notice error={(save.error as AdminApiError).code} /> : null}
    <button className="primary" disabled={save.isPending}>{save.isPending ? "Сохраняем…" : `Сохранить v${(item?.version ?? 0) + 1}`}</button>
  </form>;
}

export function PromotionsView() {
  const query = useControlRoomQuery<MerchantPromotionsResponse>("promotions", "/promotions");
  const [selected, setSelected] = useState<string | null>(null);
  const item = query.data?.promotions.find((promotion) => promotion.id === selected) ?? null;
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ПРОМО" title={<>Свой namespace.<br /><i>Чужой код — в Refref.</i></>} text="Merchant-промо применяются до Refref. Код с зарезервированным префиксом никогда не проваливается во внешнюю систему." />
    <Panel title={query.data ? `Промокоды · ${query.data.reservedPrefix}` : "Промокоды"}>
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.promotions.length}>
        <table><thead><tr><th>Код</th><th>Скидка</th><th>Offer</th><th>Статус</th><th>Версия</th></tr></thead><tbody>{query.data.promotions.map((promotion) => <tr key={promotion.id}>
          <td><strong>{promotion.code}</strong></td><td>{promotion.discountKind === "FIXED" ? money(promotion.discountValue) : `${promotion.discountValue / 100}%`}</td>
          <td>{promotion.eligibleOfferRef ?? "Все"}</td><td><Badge>{promotion.active ? "ACTIVE" : "INACTIVE"}</Badge></td>
          <td>v{promotion.version}<button onClick={() => setSelected(promotion.id)}>Изменить</button></td>
        </tr>)}</tbody></table>
      </QueryState>}
      <button onClick={() => setSelected("__new__")}>Добавить промокод</button>
    </Panel>
    {selected ? <Panel title={selected === "__new__" ? "Новый промокод" : "Версионная команда"}>
      <PromotionEditor key={selected === "__new__" ? "new" : `${item?.id}:${item?.version}`} item={item} />
    </Panel> : null}
  </>;
}

export function LabCatalogue() {
  const query = useControlRoomQuery<LabOccurrencesResponse>("lab", "/lab");
  const cities = useControlRoomQuery<CitiesResponse>("cities", "/cities");
  const [selected, setSelected] = useState<string | null>(null);
  const occurrence = query.data?.occurrences.find((item) => item.occurrenceRef === selected) ?? null;
  return <>
    <PageTitle eyebrow="КАТАЛОГ / LAB" title={<>Встреча отдельно.<br /><i>Продажа отдельно.</i></>} text="Occurrence хранит расписание, площадку и места; цена и режим продажи — один оффер Commerce. Продажи LAB закрыты до отдельной приёмки: PUBLIC требует sales activation." />
    <Panel title="Occurrence">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.occurrences.length}>
        <table><thead><tr><th>Событие</th><th>Город</th><th>Начало</th><th>Места</th><th>Статус</th><th>Продажи</th></tr></thead><tbody>
          {query.data.occurrences.map((item) => <tr key={item.occurrenceRef}><td><strong>{item.title}</strong><small>{item.occurrenceRef} · v{item.version}</small></td><td>{item.cityTitle}</td><td>{dateTime(item.startsAt)}</td><td>{item.availableSeats} / {item.capacity}<small>продано {item.soldSeats} · в оплате {item.pendingSeats} · резерв {item.adminReservedSeats}</small></td><td><Badge>{item.phase}</Badge><small>{item.visibility}</small></td><td>{item.offer ? <strong>{money(item.offer.priceKopecks)}</strong> : null}<Badge>{item.saleMode ?? "NO OFFER"}</Badge><button onClick={() => setSelected(item.occurrenceRef)}>Изменить</button></td></tr>)}
        </tbody></table>
      </QueryState>}
      <button onClick={() => setSelected("__new__")}>Добавить occurrence</button>
    </Panel>
    {selected && cities.data ? <Panel title={selected === "__new__" ? "Новая occurrence" : "Версионная команда"}>
      <LabOccurrenceEditor key={selected === "__new__" ? "new" : `${occurrence?.occurrenceRef}:${occurrence?.version}:${occurrence?.offer?.productVersion ?? 0}`}
        occurrence={occurrence} cities={cities.data.cities} onCreated={setSelected} />
    </Panel> : null}
    <LabCheckIn />
  </>;
}

export function CitiesCatalogue() {
  const query = useControlRoomQuery<CitiesResponse>("cities", "/cities");
  const [selected, setSelected] = useState<string | null>(null);
  const city = query.data?.cities.find((item) => item.slug === selected) ?? null;
  return <>
    <PageTitle eyebrow="КАТАЛОГ / ГЕОГРАФИЯ" title={<>Города<br /><i>как справочник.</i></>} text="Стабильные городские идентификаторы и число связанных LAB occurrence. Slug не меняется; меняется только название." />
    <Panel title="Города">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.cities.length}>
        <table><thead><tr><th>Название</th><th>Slug</th><th>Occurrence</th></tr></thead><tbody>
          {query.data.cities.map((item) => <tr key={item.cityId}><td><strong>{item.title}</strong></td><td><code>{item.slug}</code></td><td>{item.occurrenceCount}<button onClick={() => setSelected(item.slug)}>Переименовать</button></td></tr>)}
        </tbody></table>
      </QueryState>}
      <button onClick={() => setSelected("__new__")}>Добавить город</button>
    </Panel>
    {selected ? <Panel title={selected === "__new__" ? "Новый город" : "Название города"}>
      <CityEditor key={selected === "__new__" ? "new" : `${city?.slug}:${city?.title}`} city={city} />
    </Panel> : null}
  </>;
}

export function OrdersView() {
  const query = useControlRoomQuery<OrdersResponse>("orders", "/orders");
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ЗАКАЗЫ" title={<>Один заказ.<br /><i>Две правды.</i></>} text="Flexperiment хранит договор и fulfilment; Refref — выполнение оплаты. Эти состояния показаны рядом, но не смешаны." />
    <Panel title="Заказы">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.orders.length}>
        <table><thead><tr><th>Заказ</th><th>Клиент</th><th>Продукт</th><th>Сумма</th><th>Flexperiment</th><th>Rail</th></tr></thead><tbody>
          {query.data.orders.map((order) => <tr key={order.orderPublicId}><td><strong>{order.orderPublicId}</strong><small>{dateTime(order.createdAt)}</small></td><td>{order.customerEmail}</td><td><strong>{order.title}</strong><small>{order.productKind}</small></td><td>{money(order.amountKopecks)}</td><td><Badge>{order.state}</Badge></td><td><Badge>{order.railState}</Badge><small>{order.refrefAttemptId ?? "—"}</small></td></tr>)}
        </tbody></table>
      </QueryState>}
    </Panel>
  </>;
}

export function CustomersView() {
  const query = useControlRoomQuery<CustomersResponse>("customers", "/customers");
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / КЛИЕНТЫ" title={<>Гость сегодня.<br /><i>Аккаунт завтра.</i></>} text="Email связывает LAB-покупателя с будущим аккаунтом без второго customer record." />
    <Panel title="Клиенты">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.customers.length}>
        <table><thead><tr><th>Клиент</th><th>Аккаунт</th><th>Заказы</th><th>Активные доступы</th><th>Создан</th></tr></thead><tbody>
          {query.data.customers.map((customer) => <tr key={customer.customerId}><td><strong>{customer.displayName ?? customer.email}</strong><small>{customer.customerId}</small></td><td><Badge>{customer.authBound ? "BOUND" : "GUEST"}</Badge></td><td>{customer.orderCount}</td><td>{customer.activeEntitlementCount}</td><td>{dateTime(customer.createdAt)}</td></tr>)}
        </tbody></table>
      </QueryState>}
    </Panel>
  </>;
}

function ManualEntitlementGrant({ customers, courses }: {
  customers: CustomersResponse["customers"];
  courses: CatalogueResponse["courses"];
}) {
  const client = useQueryClient();
  const [customerId, setCustomerId] = useState("");
  const [scope, setScope] = useState<"COURSE" | "ALL_COURSES">("COURSE");
  const [courseRef, setCourseRef] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [legalTermsRef, setLegalTermsRef] = useState("manual-access-v1");
  const [commandKey, setCommandKey] = useState(idempotencyKey);
  const grant = useMutation({
    mutationFn: (command: ManualEntitlementGrantCommand) => api("/v2/entitlements/manual", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSuccess: () => {
      setReason("");
      setEvidenceRef("");
      setCommandKey(idempotencyKey());
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["control-room-v2", "entitlements"] });
      void client.invalidateQueries({ queryKey: ["control-room-v2", "customers"] });
    },
  });
  return <form className="form form-grid" onSubmit={(event) => {
    event.preventDefault();
    grant.mutate({
      customerId,
      scope,
      ...(scope === "COURSE" ? { courseRef } : {}),
      reason,
      evidenceRef,
      legalTermsRef,
      idempotencyKey: commandKey,
    });
  }}>
    <label>Клиент<select required value={customerId} onChange={(event) => setCustomerId(event.target.value)}><option value="">Выберите клиента</option>{customers.map((customer) => <option key={customer.customerId} value={customer.customerId}>{customer.email}</option>)}</select></label>
    <label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as "COURSE" | "ALL_COURSES")}><option value="COURSE">Один курс</option><option value="ALL_COURSES">Все нынешние и будущие курсы</option></select></label>
    {scope === "COURSE" ? <label>Курс<select required value={courseRef} onChange={(event) => setCourseRef(event.target.value)}><option value="">Выберите курс</option>{courses.map((course) => <option key={course.courseRef} value={course.courseRef}>{course.courseRef}</option>)}</select></label> : null}
    <label>Версия условий<input required value={legalTermsRef} onChange={(event) => setLegalTermsRef(event.target.value)} /></label>
    <label className="wide">Основание<textarea required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <label className="wide">Ссылка на доказательство<input required value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} /></label>
    {grant.error ? <Notice error={(grant.error as AdminApiError).code} /> : null}
    <button className="primary wide" disabled={grant.isPending} type="submit">{grant.isPending ? "Фиксируем…" : "Выдать ручной доступ"}</button>
  </form>;
}

function ManualEntitlementRevocation({ entitlementId }: { entitlementId: string }) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const revoke = useMutation({
    mutationFn: (command: ManualEntitlementRevocationCommand) => api(`/v2/entitlements/${entitlementId}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["control-room-v2", "entitlements"] });
      void client.invalidateQueries({ queryKey: ["control-room-v2", "customers"] });
    },
  });
  return <details><summary>Отозвать</summary><form className="form" onSubmit={(event) => {
    event.preventDefault();
    revoke.mutate({ reason, evidenceRef });
  }}>
    <label>Причина<input required value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <label>Доказательство<input required value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} /></label>
    {revoke.error ? <Notice error={(revoke.error as AdminApiError).code} /> : null}
    <button className="danger" disabled={revoke.isPending} type="submit">{revoke.isPending ? "Отзываем…" : "Подтвердить отзыв"}</button>
  </form></details>;
}

export function EntitlementsView() {
  const query = useControlRoomQuery<EntitlementsResponse>("entitlements", "/entitlements");
  const customers = useControlRoomQuery<CustomersResponse>("customers", "/customers");
  const catalogue = useControlRoomQuery<CatalogueResponse>("catalogue", "/catalogue");
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ДОСТУПЫ" title={<>Доступ — это<br /><i>доказательство.</i></>} text="Каждый grant связан с конкретной строкой заказа. Unlisted не отзывает доступ; refund покрывает только свой источник." />
    <Panel title="Ручной доступ">
      {customers.error ? readError(customers.error) : catalogue.error ? readError(catalogue.error) : !customers.data || !catalogue.data ? <Loading />
        : <ManualEntitlementGrant customers={customers.data.customers} courses={catalogue.data.courses} />}
    </Panel>
    <Panel title="Entitlements">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.entitlements.length}>
        <table><thead><tr><th>Клиент</th><th>Scope</th><th>Курс</th><th>Источник</th><th>Состояние</th><th>Команда</th></tr></thead><tbody>
          {query.data.entitlements.map((item) => <tr key={item.entitlementId}><td>{item.customerEmail}<small>{item.customerId}</small></td><td><Badge>{item.scope}</Badge></td><td>{item.courseRef ?? "Все курсы"}</td><td><Badge>{item.sourceKind}</Badge><small><code>{item.sourceOrderPublicId}</code></small></td><td><Badge>{item.revokedAt ? "REVOKED" : "ACTIVE"}</Badge><small>{item.revocationReason ?? dateTime(item.grantedAt)}</small></td><td>{item.sourceKind === "MANUAL" && !item.revokedAt ? <ManualEntitlementRevocation entitlementId={item.entitlementId} /> : "—"}</td></tr>)}
        </tbody></table>
      </QueryState>}
    </Panel>
  </>;
}

function RefundDecision({ item }: { item: ControlRoomRefundCase }) {
  const client = useQueryClient();
  const [outcome, setOutcome] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [amount, setAmount] = useState(String(item.policyFacts.paidLineAmountKopecks));
  const [basis, setBasis] = useState("");
  const [rationale, setRationale] = useState("");
  const decision = useMutation({
    mutationFn: (command: Omit<RefundDecisionCommand, "actor">) => api(`/v2/refunds/${item.requestPublicId}/decision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }),
    onSettled: () => client.invalidateQueries({ queryKey: ["control-room-v2", "refunds"] }),
  });
  const execute = useMutation({
    mutationFn: () => api(`/v2/refunds/${item.requestPublicId}/execute`, { method: "POST" }),
    onSettled: () => client.invalidateQueries({ queryKey: ["control-room-v2", "refunds"] }),
  });
  if (item.state !== "REQUESTED") return <>
    {execute.error ? <Notice error={(execute.error as AdminApiError).code} /> : null}
    <button className="primary" disabled={item.state !== "APPROVED" || execute.isPending} onClick={() => execute.mutate()}>{execute.isPending ? "Передаём…" : "Исполнить в Refref"}</button>
  </>;
  return <form className="refund-decision" onSubmit={(event) => {
    event.preventDefault();
    decision.mutate({ outcome, ...(outcome === "APPROVE" ? { amountKopecks: Number(amount) } : {}), policyBasis: basis, rationale });
  }}>
    <label>Решение<select value={outcome} onChange={(event) => setOutcome(event.target.value as "APPROVE" | "REJECT")}><option value="APPROVE">Одобрить</option><option value="REJECT">Отказать</option></select></label>
    {outcome === "APPROVE" ? <label>Сумма, коп.<input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} /></label> : null}
    <label>Основание<input required value={basis} onChange={(event) => setBasis(event.target.value)} placeholder="Версия оферты / правило" /></label>
    <label>Мотивировка<textarea required value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
    {decision.error ? <Notice error={(decision.error as AdminApiError).code} /> : null}
    <button className="primary" disabled={decision.isPending}>{decision.isPending ? "Фиксируем…" : "Зафиксировать решение"}</button>
  </form>;
}

function RegisterEmailRefund({ onRegistered }: { onRegistered: (requestPublicId: string) => void }) {
  const client = useQueryClient();
  const [orderPublicId, setOrder] = useState("");
  const [senderEmail, setSender] = useState("");
  const [evidenceRef, setEvidence] = useState("");
  const [receivedAt, setReceived] = useState("");
  const [customerNote, setNote] = useState("");
  const [command, setCommand] = useState<RefundEmailRegistrationCommand | null>(null);
  const registration = useMutation({
    mutationFn: (body: RefundEmailRegistrationCommand) => api<{ requestPublicId: string }>("/v2/refunds", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    retry: false,
    onSuccess: (result) => {
      setCommand(null); setOrder(""); setSender(""); setEvidence(""); setReceived(""); setNote("");
      onRegistered(result.requestPublicId);
      return client.invalidateQueries({ queryKey: ["control-room-v2", "refunds"] });
    },
    onError: (error: AdminApiError) => {
      // Only explicit input refusals allow editing. A lost/5xx response retains the exact command.
      if (["REFUND_ORDER_REQUIRED", "REFUND_EMAIL_EVIDENCE_REQUIRED", "REFUND_EMAIL_SENDER_REQUIRED",
        "REFUND_EMAIL_SENDER_INVALID", "REFUND_EMAIL_SENDER_MISMATCH", "REFUND_EMAIL_RECEIVED_AT_INVALID",
        "REFUND_NOTE_TOO_LONG", "REFUND_NOTE_INVALID", "REFUND_REQUEST_NOT_AVAILABLE"].includes(error.code)) setCommand(null);
    },
  });
  return <Panel title="Зарегистрировать обращение из почты">
    <p>Проверьте письмо на refunds@flexperiment.ru и покупку. Регистрация создаёт только заявку; решение и исполнение выполняются отдельно.</p>
    <form className="refund-decision" onSubmit={(event) => {
      event.preventDefault();
      const body = command ?? { orderPublicId, senderEmail, evidenceRef, receivedAt: new Date(receivedAt).toISOString(),
        customerNote, idempotencyKey: idempotencyKey() };
      setCommand(body);
      registration.mutate(body);
    }}>
      <label>Номер заказа<input required maxLength={200} disabled={Boolean(command)} value={orderPublicId} onChange={(event) => setOrder(event.target.value)} /></label>
      <label>Почта отправителя<input required type="email" maxLength={320} disabled={Boolean(command)} value={senderEmail} onChange={(event) => setSender(event.target.value)} /></label>
      <label>Ссылка или ID письма<input required maxLength={1000} disabled={Boolean(command)} value={evidenceRef} onChange={(event) => setEvidence(event.target.value)} /></label>
      <label>Письмо получено (ваше местное время)<input required type="datetime-local" disabled={Boolean(command)} value={receivedAt} onChange={(event) => setReceived(event.target.value)} /></label>
      <label>Суть обращения<textarea maxLength={2000} disabled={Boolean(command)} value={customerNote} onChange={(event) => setNote(event.target.value)} /></label>
      {registration.error ? <Notice error={registration.error.code} /> : null}
      {command && !registration.isPending ? <p role="status">Сверьте очередь заявок. Повтор отправит те же данные с прежним ключом.</p> : null}
      <button className="primary" disabled={registration.isPending}>{registration.isPending ? "Регистрируем…" : command ? "Повторить регистрацию" : "Зарегистрировать заявку"}</button>
      {registration.isSuccess ? <p role="status">Заявка зарегистрирована. Выберите её для отдельного решения.</p> : null}
    </form>
  </Panel>;
}

export function RefundsView() {
  const query = useControlRoomQuery<RefundCasesResponse>("refunds", "/refunds");
  const [selected, setSelected] = useState<string | null>(null);
  const item = query.data?.refunds.find((refund) => refund.requestPublicId === selected) ?? null;
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ВОЗВРАТЫ" title={<>Решение здесь.<br /><i>Деньги — в Refref.</i></>} text="Запрос, решение и внешний эффект разделены. Сетевой таймаут не превращается во второй возврат." />
    <RegisterEmailRefund onRegistered={setSelected} />
    <section className="refund-workbench">
      <Panel title="Очередь решений">
        {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.refunds.length}>
          <div className="case-list">{query.data.refunds.map((refund) => <button className={selected === refund.requestPublicId ? "case-card active" : "case-card"} key={refund.requestPublicId} onClick={() => setSelected(refund.requestPublicId)}>
            <span><Badge>{refund.state}</Badge><Badge>{refund.executionState ?? "NO EXECUTION"}</Badge></span>
            <strong>{refund.orderPublicId}</strong>
            <small>{refund.reasonCode} · {money(refund.policyFacts.paidLineAmountKopecks)}</small>
          </button>)}</div>
        </QueryState>}
      </Panel>
      <Panel title="Досье возврата">
        {!item ? <p className="empty">Выберите запрос слева.</p> : <div className="refund-dossier">
          <div className="dossier-grid"><div><small>Доступ начат</small><strong>{dateTime(item.policyFacts.courseAccessStartedAt)}</strong></div><div><small>Запрошен</small><strong>{dateTime(item.requestedAt)}</strong></div><div><small>Policy</small><strong>{item.policyBasis ?? "решение не принято"}</strong></div><div><small>Refref support</small><strong>{item.supportReference ?? "—"}</strong></div></div>
          {item.policyFacts.emailIntake ? <section aria-label="Доказательство email-обращения">
            <p>Письмо: {item.policyFacts.emailIntake.evidenceRef}</p>
            <p>Получено: {dateTime(item.policyFacts.emailIntake.receivedAt)} · Зарегистрировал: {item.policyFacts.emailIntake.registeredBy}</p>
          </section> : null}
          {item.customerNote ? <p>Обращение покупателя: {item.customerNote}</p> : null}
          {item.rationale ? <blockquote>{item.rationale}</blockquote> : null}
          <RefundDecision item={item} />
        </div>}
      </Panel>
    </section>
  </>;
}

export function IntegrationView() {
  const integration = useControlRoomQuery<ControlRoomIntegrationSummary>("integration", "/integration");
  const attention = useControlRoomQuery<AttentionResponse>("attention", "/attention");
  const error = integration.error ?? attention.error;
  return <>
    <PageTitle eyebrow="ИНТЕГРАЦИИ / REFREF" title={<>Связь видна.<br /><i>Authority не смешана.</i></>} text="Панель отвечает на вопросы merchant-оператора и не притворяется встроенной админкой Refref." />
    {error ? readError(error) : !integration.data || !attention.data ? <Loading /> : <section className="two-col">
      <Panel title="Refref / checkout"><div className="signal-list"><div className="signal-row"><span>Режим</span><strong>{integration.data.paymentMode}</strong></div><div className="signal-row"><span>Незавершённые checkout</span><strong>{integration.data.outstandingCheckoutCount}</strong></div><div className="signal-row"><span>Возвраты в обработке</span><strong>{integration.data.processingRefundCount}</strong></div></div></Panel>
      <Panel title="Playback / 24 часа"><div className="signal-list"><div className="signal-row"><span>Разрешено</span><strong>{integration.data.playbackAccess24h.allowed}</strong></div><div className="signal-row"><span>Отказано</span><strong className={integration.data.playbackAccess24h.denied ? "signal-hot" : ""}>{integration.data.playbackAccess24h.denied}</strong></div><div className="signal-row"><span>Rate limited</span><strong className={integration.data.playbackAccess24h.rateLimited ? "signal-hot" : ""}>{integration.data.playbackAccess24h.rateLimited}</strong></div><div className="signal-row"><span>Invalid token</span><strong className={integration.data.playbackAccess24h.invalidToken ? "signal-hot" : ""}>{integration.data.playbackAccess24h.invalidToken}</strong></div></div></Panel>
      <Panel title="Attention queue"><QueryState error={null} empty={!attention.data.items.length}><div className="case-list">{attention.data.items.map((entry) => <article className="case-card" key={entry.operationId}><span><Badge>{entry.state}</Badge><Badge>{entry.scopeLevel}</Badge></span><strong>{entry.courseRef}</strong><small>{entry.attentionReason} · {entry.scopeRef}</small></article>)}</div></QueryState></Panel>
    </section>}
  </>;
}

export function EmailOperationsView() {
  const query = useControlRoomQuery<EmailOperationsResponse>("email", "/email");
  return <>
    <PageTitle eyebrow="ОПЕРАЦИИ / EMAIL" title={<>Отправка видна.<br /><i>Согласие решает.</i></>} text="Magic-link outbox и авторские кампании показаны отдельно. Campaign state не отменяет повторную проверку consent и suppression при каждой отправке." />
    {query.error ? readError(query.error) : !query.data ? <Loading /> : <section className="two-col">
      <Panel title="Magic links"><QueryState error={null} empty={!query.data.authEmails.length}><div className="case-list">{query.data.authEmails.map((email) => <article className="case-card" key={email.id}><span><Badge>{email.state}</Badge><Badge>{email.attemptCount} attempts</Badge></span><strong>{email.recipient}</strong><small>{email.lastError ?? dateTime(email.updatedAt)}</small></article>)}</div></QueryState></Panel>
      <Panel title="Кампании"><QueryState error={null} empty={!query.data.campaigns.length}><div className="case-list">{query.data.campaigns.map((campaign) => <article className="case-card" key={campaign.id}><span><Badge>{campaign.state}</Badge><Badge>{campaign.sentCount}/{campaign.recipientCount}</Badge></span><strong>{campaign.courseRef}</strong><small>failed {campaign.failedCount} · skipped {campaign.skippedCount} · {dateTime(campaign.createdAt)}</small></article>)}</div></QueryState></Panel>
    </section>}
  </>;
}

export function IncidentsView() {
  const query = useControlRoomQuery<IncidentsResponse>("incidents", "/incidents");
  return <>
    <PageTitle eyebrow="ОПЕРАЦИИ / ИНЦИДЕНТЫ" title={<>Не шум.<br /><i>Только действие.</i></>} text="Здесь собраны неоднозначные внешние эффекты, отказавшая доставка и access overrides, которые нельзя снять по таймауту." />
    <Panel title="Attention queue">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.incidents.length}><table><thead><tr><th>Тип</th><th>Объект</th><th>Код</th><th>Уровень</th><th>Время</th></tr></thead><tbody>{query.data.incidents.map((incident) => <tr key={incident.incidentRef}><td><Badge>{incident.kind}</Badge></td><td><code>{incident.subjectRef}</code></td><td>{incident.code}</td><td><Badge>{incident.severity}</Badge></td><td>{dateTime(incident.observedAt)}</td></tr>)}</tbody></table></QueryState>}
    </Panel>
  </>;
}

export function AuditView() {
  const query = useControlRoomQuery<AuditResponse>("audit", "/audit");
  return <>
    <PageTitle eyebrow="ОПЕРАЦИИ / АУДИТ" title={<>Кто решил.<br /><i>Что изменилось.</i></>} text="Merchant-domain evidence и Control Room session audit сведены в одну хронологию без секретов и credential payloads." />
    <Panel title="Последние 250 событий">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.entries.length}><table><thead><tr><th>Время</th><th>Источник</th><th>Действие</th><th>Объект</th><th>Actor</th><th>Evidence</th></tr></thead><tbody>{query.data.entries.map((entry) => <tr key={`${entry.source}:${entry.id}`}><td>{dateTime(entry.createdAt)}</td><td><Badge>{entry.source}</Badge></td><td>{entry.action}</td><td><small>{entry.entityType}</small><code>{entry.entityId}</code></td><td>{entry.actor}</td><td><code>{JSON.stringify(entry.details)}</code></td></tr>)}</tbody></table></QueryState>}
    </Panel>
  </>;
}

export function V2PendingSurface({ area }: { area: string }) {
  return <><PageTitle eyebrow="V2 / BOUNDED SURFACE" title={<>{area}<br /><i>ещё не перенесён.</i></>} text="Этот v1 экран не включён в новую Control Room. Он появится только после typed backend contract и проверки authority boundary." /><Notice error="V2_SURFACE_NOT_READY" /></>;
}
