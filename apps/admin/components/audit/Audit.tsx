"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { auditKeys } from "../../lib/query-keys";
import { formatDate, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";

export function Audit() {
  const query = useQuery({
    queryKey: auditKeys.list(),
    queryFn: () => api<{ events: Row[] }>("/audit"),
  });

  return (
    <>
      <PageTitle
        eyebrow="AUTHORITY / AUDIT"
        title={<>Команды<br /><i>с контекстом.</i></>}
        text="Показываются durable записи Admin mutations. Секреты и capability здесь не выводятся."
      />
      <section className="panel">
        <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
        {query.isLoadingError ? <Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !query.data ? <Loading /> : (
          <>
            <table>
              <thead><tr><th>Время</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
              <tbody>
                {query.data.events.map((event) => (
                  <tr key={string(event.id)}>
                    <td>{formatDate(event.created_at)}</td>
                    <td><Badge>{string(event.action)}</Badge></td>
                    <td>{string(event.entity_type)}<small>{string(event.entity_id)}</small></td>
                    <td><code>{string(event.details_json)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="truncation-caption">
              {query.data.events.length === 200 ? "Показаны первые 200; записи могут быть ещё" : "Показано до 200 записей"}
            </p>
          </>
        )}
      </section>
    </>
  );
}
