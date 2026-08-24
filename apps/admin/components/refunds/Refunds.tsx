"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { refundKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { refundFiltersFromSearchParams, refundFiltersToSearch } from "../../lib/filters";
import { formatDate, formatMoney, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";

export function Refunds() {
  const filters = typeof window === "undefined" ? {} : refundFiltersFromSearchParams(new URLSearchParams(window.location.search));
  const search = refundFiltersToSearch(filters);

  const query = useQuery({
    queryKey: refundKeys.list(filters),
    queryFn: () => api<{ refunds: Row[] }>(`/refunds${search ? `?${search}` : ""}`),
    ...pollingQuery(POLL_INTERVAL.refunds),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageTitle
        eyebrow="COMMERCE / REFUNDS"
        title={<>Возвраты<br /><i>без blind retry.</i></>}
        text="Состояние provider и внутренний state отображаются как факты. Новую операцию создают только из допустимого order evidence."
      />
      <section className="panel">
        <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
        {query.isLoadingError ? <Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !query.data ? <Loading /> : (
          <table aria-busy={query.isFetching}>
            <thead><tr><th>Создан</th><th>Заказ</th><th>Событие</th><th>Сумма</th><th>Источник</th><th>Статус</th></tr></thead>
            <tbody>
              {query.data.refunds.map((refund) => (
                <tr key={string(refund.id)}>
                  <td>{formatDate(refund.created_at)}</td>
                  <td><strong>{string(refund.public_status_id).slice(0, 11)}…</strong><small>{string(refund.order_id)}</small></td>
                  <td>{string(refund.city_title)}<small>{string(refund.occurrence_title)}</small></td>
                  <td>{formatMoney(refund.amount_kopecks)}</td>
                  <td><Badge>{string(refund.source)}</Badge></td>
                  <td><Badge>{string(refund.status)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
