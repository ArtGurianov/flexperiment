"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "../../lib/api";
import { incidentKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { incidentFiltersFromSearchParams, incidentFiltersToSearch } from "../../lib/filters";
import { formatDate, formatMoney, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Empty } from "../ui/Empty";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { OperationalIncidentResolution } from "./OperationalIncidentResolution";
import { ProviderDriftResolution } from "./ProviderDriftResolution";
import { driftKeys } from "../../lib/query-keys";

export function OperationalIncidents() {
  const searchParams = useSearchParams();
  const filters = incidentFiltersFromSearchParams(searchParams);
  const search = incidentFiltersToSearch(filters);
  const query = useQuery({
    queryKey: incidentKeys.list(filters),
    queryFn: () => api<{ incidents: Row[]; open_count: number }>(`/operational-incidents${search ? `?${search}` : ""}`),
    ...pollingQuery(POLL_INTERVAL.incidents),
  });
  const [resolving, setResolving] = useState<Row | null>(null);
  const drift = useQuery({ queryKey: driftKeys.list(), queryFn: () => api<{ reviews: Row[] }>("/provider-drift-reviews"), ...pollingQuery(POLL_INTERVAL.incidents) });
  const [resolvingDrift, setResolvingDrift] = useState<Row | null>(null);

  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS / REVIEW"
        title={<>Операционные<br /><i>инциденты.</i></>}
        text="Автоматическая фиксация создаёт review-задачу, но не делает финансовое решение за оператора."
      />
      <section className="panel">
        {filters.status === "OPEN" && <p className="notice">Показаны только открытые incidents из dashboard alarm.</p>}
        <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
        {query.isLoadingError ? <Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !query.data ? <Loading /> : (
          <>
            <p className="notice incident-count">Открыто: <strong>{query.data.open_count}</strong></p>
            {query.data.incidents.length ? (
              <table>
                <thead><tr><th>Создан</th><th>Тип</th><th>Заказ / покупатель</th><th>Возврат / provider</th><th>Статус</th></tr></thead>
                <tbody>
                  {query.data.incidents.map((incident) => (
                    <tr key={string(incident.id)}>
                      <td>{formatDate(incident.created_at)}<small>{string(incident.id)}</small></td>
                      <td><Badge>{string(incident.kind)}</Badge><small>{string(incident.entity_type)}: {string(incident.entity_id)}</small></td>
                      <td>{string(incident.public_order_number) || "—"}<small>{string(incident.customer_email) || "—"}</small></td>
                      <td>
                        {incident.refund_public_id ? (
                          <>
                            <strong>{formatMoney(incident.refund_amount_kopecks)}</strong>
                            <small>{string(incident.refund_status)} · {string(incident.refund_public_id)}</small>
                            <small>{string(incident.refund_provider_reference) || string(incident.provider_payment_id) || "provider reference отсутствует"}</small>
                            <small>{string(incident.refund_last_error) || "—"}</small>
                          </>
                        ) : <small>—</small>}
                      </td>
                      <td>
                        {string(incident.status) === "OPEN" ? <button onClick={() => setResolving(incident)}>Отметить решённым</button> : (
                          <>
                            <Badge>RESOLVED</Badge>
                            <small>{string(incident.resolution_note)}</small>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty label="Открытых или исторических инцидентов пока нет." />}
          </>
        )}
      </section>
      <section className="panel">
        <h2>Provider drift</h2>
        <p className="notice">Закрытие этой записи — только bookkeeping review. Оно не меняет статус оплаты; payment выходит из REVIEW_REQUIRED только по provider evidence.</p>
        {drift.isLoadingError ? <Notice error={(drift.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !drift.data ? <Loading /> : drift.data.reviews.length ? <table><thead><tr><th>Создан</th><th>Сущность</th><th>Evidence</th><th /></tr></thead><tbody>{drift.data.reviews.map((review) => <tr key={string(review.id)}><td>{formatDate(review.created_at)}</td><td><strong>{string(review.entity_type)}</strong><small>{string(review.entity_id)}</small></td><td><code>{string(review.observed_json)}</code></td><td><button onClick={() => setResolvingDrift(review)}>Закрыть review</button></td></tr>)}</tbody></table> : <Empty label="Открытых provider drift review пока нет." />}
      </section>
      {resolving && <OperationalIncidentResolution incident={resolving} close={() => setResolving(null)} done={() => setResolving(null)} />}
      {resolvingDrift && <ProviderDriftResolution review={resolvingDrift} close={() => setResolvingDrift(null)} done={() => setResolvingDrift(null)} />}
    </>
  );
}
