"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cityKeys, occurrenceKeys, orderKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { orderFiltersFromSearchParams, type OrderFilters } from "../../lib/filters";
import { formatDate, formatMoney, number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { OrderEvidence } from "./OrderEvidence";

const PAYMENT_STATUS_VALUES = ["PENDING", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "REVIEW_REQUIRED"];
const PAYMENT_STATE_VALUES = ["CREATING", "CREATED", "CREATE_UNKNOWN", "CREATE_FAILED"];
const BOOKING_STATUS_VALUES = ["RESERVED", "CONFIRMED", "CANCELLED"];
const ageBandLabel = (value: unknown) => ({
  ADULT: "18 лет или старше",
  MINOR_14_17: "14–17 лет",
  MINOR_UNDER_14: "младше 14 лет",
}[string(value)]);

export function Orders() {
  const cities = useQuery({ queryKey: cityKeys.list(), queryFn: () => api<{ cities: Row[] }>("/cities") });
  const occurrences = useQuery({
    queryKey: occurrenceKeys.list(),
    queryFn: () => api<{ occurrences: Row[] }>("/occurrences"),
    ...pollingQuery(POLL_INTERVAL.occurrences),
  });

  // Hydrates from the query string so a dashboard counter's deep-link (e.g.
  // /orders/?payment_state=CREATE_UNKNOWN) works on load — D3.
  const [filters, setFilters] = useState<OrderFilters>(() =>
    typeof window === "undefined" ? {} : orderFiltersFromSearchParams(new URLSearchParams(window.location.search)),
  );
  const [selected, setSelected] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("id")));

  const orders = useQuery({
    queryKey: orderKeys.list(filters),
    queryFn: () => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
      const qs = search.toString();
      return api<{ orders: Row[] }>(`/orders${qs ? `?${qs}` : ""}`);
    },
    ...pollingQuery(POLL_INTERVAL.orders),
    placeholderData: keepPreviousData,
  });

  // Reflect filter + selection state back into the address bar so the URL
  // stays a valid description of what's on screen (matches D3's deep-link contract).
  useEffect(() => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
    if (selected) search.set("id", selected);
    const qs = search.toString();
    history.replaceState(null, "", `/orders/${qs ? `?${qs}` : ""}`);
  }, [filters, selected]);

  return (
    <>
      <PageTitle
        eyebrow="COMMERCE / ORDERS"
        title={<>Заказы<br /><i>и их evidence.</i></>}
        text="Payment, booking, ticket, email и refund остаются отдельными фактами. Экран не сворачивает их в одну фиктивную метку."
      />
      <section className="panel">
        <div className="filters">
          <label>
            Город
            <select value={filters.city_id ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, city_id: event.target.value }))}>
              <option value="">Все</option>
              {cities.data?.cities.map((city) => <option key={string(city.id)} value={string(city.id)}>{string(city.title)}</option>)}
            </select>
          </label>
          <label>
            Событие
            <select value={filters.occurrence_id ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, occurrence_id: event.target.value }))}>
              <option value="">Все</option>
              {occurrences.data?.occurrences.map((occurrence) => <option key={string(occurrence.id)} value={string(occurrence.id)}>{string(occurrence.title)}</option>)}
            </select>
          </label>
          <label>
            Payment status
            <select value={filters.payment_status ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, payment_status: event.target.value }))}>
              <option value="">Все</option>
              {PAYMENT_STATUS_VALUES.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Payment state
            <select value={filters.payment_state ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, payment_state: event.target.value }))}>
              <option value="">Все</option>
              {PAYMENT_STATE_VALUES.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Booking
            <select value={filters.booking_status ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, booking_status: event.target.value }))}>
              <option value="">Все</option>
              {BOOKING_STATUS_VALUES.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <Freshness query={{ ...orders, hasData: Boolean(orders.data) }} />
        {orders.isLoadingError ? <Notice error={(orders.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !orders.data ? <Loading /> : (
          <>
            <table aria-busy={orders.isFetching} className={orders.isPlaceholderData ? "table-updating" : ""}>
              <thead>
                <tr><th>Дата</th><th>Заказ</th><th>Событие</th><th>Контакт заказа</th><th>Участник</th><th>Сумма</th><th>Состояния</th></tr>
              </thead>
              <tbody>
                {orders.data.orders.map((order) => (
                  <tr
                    className="click-row"
                    onClick={() => { setSelected(string(order.id)); }}
                    key={string(order.id)}
                  >
                    <td>{formatDate(order.created_at)}</td>
                    <td><strong>{string(order.public_order_number) || `${string(order.public_status_id).slice(0, 11)}…`}</strong><small>{string(order.id)}</small></td>
                    <td>{string(order.city_title)}<small>{string(order.occurrence_title)}</small></td>
                    <td>{string(order.customer_name) && <strong>{string(order.customer_name)}</strong>}<small>{string(order.customer_email)}</small></td>
                    <td>
                      {string(order.participant_name) || (string(order.customer_name) ? string(order.customer_name) : "Без имени")}
                      <small>{ageBandLabel(order.participant_age_band)
                        ? `Возраст при оформлении: ${ageBandLabel(order.participant_age_band)}`
                        : order.participant_age_at_occurrence === null || order.participant_age_at_occurrence === undefined
                          ? "Возраст legacy: неизвестен"
                          : `Возраст на дату события (legacy): ${number(order.participant_age_at_occurrence)} лет`}</small>
                      {order.participant_is_customer === 1 && <small>Заказчик и участник</small>}
                      {order.participant_is_customer === 0 && <small>Другой участник</small>}
                      {order.participant_is_customer === null && <small>Допуск по билету</small>}
                      {Boolean(order.minor_legal_representative_confirmed_at) && <Badge>ПРЕДСТАВИТЕЛЬ ПОДТВЕРЖДЁН</Badge>}
                      {order.participant_requires_adult_accompaniment === 1 && <Badge>ТРЕБУЕТСЯ СОПРОВОЖДЕНИЕ</Badge>}
                    </td>
                    <td>{formatMoney(order.amount_kopecks)}</td>
                    <td><Badge>{string(order.payment_state)}</Badge><Badge>{string(order.payment_status)}</Badge><Badge>{string(order.booking_status)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="truncation-caption">
              {orders.data.orders.length === 100 ? "Показаны первые 100; записи могут быть ещё" : "Показано до 100 записей"}
            </p>
          </>
        )}
      </section>
      {selected && <OrderEvidence id={selected} close={() => { setSelected(null); }} />}
    </>
  );
}
