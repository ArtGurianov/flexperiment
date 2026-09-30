"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, AdminApiError } from "../../lib/api";
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
  OrdersResponse,
  ProductConfigurationCommand,
  ProductWithdrawalCommand,
  RefundCasesResponse,
  RefundDecisionCommand,
} from "../../lib/control-room-contracts";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Panel } from "../ui/Panel";

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
  const [price, setPrice] = useState(String(course?.offer?.priceKopecks ?? 0));
  const [saleMode, setSaleMode] = useState<"CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC">(course?.offer?.saleMode ?? "CLOSED");
  const [allowlist, setAllowlist] = useState(course?.offer?.acceptanceAllowlist.join("\n") ?? "");
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
        priceKopecks: Number(price), saleMode,
        acceptanceAllowlist: allowlist.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
        expectedVersion: course?.version ?? 0 });
    }}>
      <label>Product ref<input required disabled={Boolean(course)} value={productRef} onChange={(event) => setProductRef(event.target.value)} /></label>
      <label>Course ref<input required disabled={Boolean(course)} value={courseRef} onChange={(event) => setCourseRef(event.target.value)} /></label>
      <label>Offer ref<input required value={offerRef} onChange={(event) => setOfferRef(event.target.value)} /></label>
      <label>Модель доступа<select value={accessModel} onChange={(event) => setAccessModel(event.target.value as "FREE" | "PAID")}><option value="FREE">FREE</option><option value="PAID">PAID</option></select></label>
      <label>Цена, коп.<input required inputMode="numeric" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
      <label>Режим продажи<select value={saleMode} onChange={(event) => setSaleMode(event.target.value as typeof saleMode)}><option value="CLOSED">CLOSED</option><option value="ACCEPTANCE_ONLY">ACCEPTANCE_ONLY</option><option value="PUBLIC">PUBLIC</option></select></label>
      {saleMode === "ACCEPTANCE_ONLY" ? <label>Allowlist<textarea value={allowlist} onChange={(event) => setAllowlist(event.target.value)} placeholder="buyer@example.ru" /></label> : null}
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
    <PageTitle eyebrow="КАТАЛОГ / КУРСЫ" title={<>Редакция отдельно.<br /><i>Продажа отдельно.</i></>} text="Payload публикует содержание. Здесь видна только коммерческая истина: бесплатность, цена, режим продажи и отзыв продукта." />
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
  return <>
    <PageTitle eyebrow="КАТАЛОГ / LAB" title={<>LAB переехал.<br /><i>Продажи закрыты.</i></>} text="Stage A сохраняет паузу продаж. Экран показывает перенесённые occurrence-записи, но не даёт обойти PAYMENT_MODE и sales activation." />
    <Panel title="Occurrence">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.occurrences.length}>
        <table><thead><tr><th>Событие</th><th>Город</th><th>Начало</th><th>Вместимость</th><th>Продажи</th></tr></thead><tbody>
          {query.data.occurrences.map((item) => <tr key={item.occurrenceRef}><td><strong>{item.title}</strong><small>{item.occurrenceRef}</small></td><td>{item.cityTitle}</td><td>{dateTime(item.startsAt)}</td><td>{item.capacity}</td><td><Badge>{item.salesStatus}</Badge></td></tr>)}
        </tbody></table>
      </QueryState>}
    </Panel>
  </>;
}

export function CitiesCatalogue() {
  const query = useControlRoomQuery<CitiesResponse>("cities", "/cities");
  return <>
    <PageTitle eyebrow="КАТАЛОГ / ГЕОГРАФИЯ" title={<>Города<br /><i>как справочник.</i></>} text="Стабильные городские идентификаторы и число связанных LAB occurrence." />
    <Panel title="Города">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.cities.length}>
        <table><thead><tr><th>Название</th><th>Slug</th><th>Occurrence</th></tr></thead><tbody>
          {query.data.cities.map((city) => <tr key={city.cityId}><td><strong>{city.title}</strong></td><td><code>{city.slug}</code></td><td>{city.occurrenceCount}</td></tr>)}
        </tbody></table>
      </QueryState>}
    </Panel>
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

export function EntitlementsView() {
  const query = useControlRoomQuery<EntitlementsResponse>("entitlements", "/entitlements");
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ДОСТУПЫ" title={<>Доступ — это<br /><i>доказательство.</i></>} text="Каждый grant связан с конкретной строкой заказа. Unlisted не отзывает доступ; refund покрывает только свой источник." />
    <Panel title="Entitlements">
      {query.error ? readError(query.error) : !query.data ? <Loading /> : <QueryState error={null} empty={!query.data.entitlements.length}>
        <table><thead><tr><th>Клиент</th><th>Scope</th><th>Курс</th><th>Источник</th><th>Состояние</th></tr></thead><tbody>
          {query.data.entitlements.map((item) => <tr key={item.entitlementId}><td>{item.customerEmail}<small>{item.customerId}</small></td><td><Badge>{item.scope}</Badge></td><td>{item.courseRef ?? "Все курсы"}</td><td><code>{item.sourceOrderPublicId}</code></td><td><Badge>{item.revokedAt ? "REVOKED" : "ACTIVE"}</Badge><small>{item.revocationReason ?? dateTime(item.grantedAt)}</small></td></tr>)}
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

export function RefundsView() {
  const query = useControlRoomQuery<RefundCasesResponse>("refunds", "/refunds");
  const [selected, setSelected] = useState<string | null>(null);
  const item = query.data?.refunds.find((refund) => refund.requestPublicId === selected) ?? null;
  return <>
    <PageTitle eyebrow="ПРОДАЖИ / ВОЗВРАТЫ" title={<>Решение здесь.<br /><i>Деньги — в Refref.</i></>} text="Запрос, решение и внешний эффект разделены. Сетевой таймаут не превращается во второй возврат." />
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
