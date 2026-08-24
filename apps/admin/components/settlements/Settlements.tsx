"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "../../lib/api";
import { settlementKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { settlementFiltersFromSearchParams, settlementFiltersToSearch } from "../../lib/filters";
import { formatDate, formatMoney, number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { SettlementDetail } from "./SettlementDetail";

export function Settlements() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = settlementFiltersFromSearchParams(searchParams);
  const search = settlementFiltersToSearch(filters);
  const query = useQuery({
    queryKey: settlementKeys.list(filters),
    queryFn: () => api<{ settlements: Row[] }>(`/reward-settlements${search ? `?${search}` : ""}`),
    ...pollingQuery(POLL_INTERVAL.settlements),
  });
  const [selected, setSelected] = useState<string | null>(() => searchParams.get("id"));
  const replaceSelection = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("id", id); else params.delete("id");
    router.replace(`/settlements/${params.size ? `?${params.toString()}` : ""}`);
    setSelected(id);
  };

  return (
    <>
      <PageTitle
        eyebrow="PROMOTERS / MANUAL SETTLEMENTS"
        title={<>Расчёты<br /><i>без ложной оплаты.</i></>}
        text="PREPARED уже резервирует начисление. Stale state — это durable operator review, а не автоматическое освобождение денег."
      />
      <section className="panel">
        {filters.stale_prepared && <p className="notice">Показаны только stale PREPARED settlements из dashboard alarm.</p>}
        <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
        {query.isLoadingError ? <Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} /> : !query.data ? <Loading /> : (
          <table aria-busy={query.isFetching}>
            <thead><tr><th>Подготовлен</th><th>Агент</th><th>Событие</th><th>Сумма</th><th>Состояние</th><th>Evidence</th></tr></thead>
            <tbody>
              {query.data.settlements.map((settlement) => (
                <tr
                  className="click-row"
                  onClick={() => replaceSelection(string(settlement.id))}
                  key={string(settlement.id)}
                >
                  <td>{formatDate(settlement.prepared_at)}</td>
                  <td><strong>{string(settlement.agent_display_name)}</strong><small>{string(settlement.agent_slug)}</small></td>
                  <td>{string(settlement.city_title)}<small>{string(settlement.occurrence_title)}</small></td>
                  <td>{formatMoney(settlement.amount_kopecks)}</td>
                  <td>
                    <Badge>{string(settlement.status)}</Badge>
                    {number(settlement.stale_prepared) === 1 && <Badge>STALE_PREPARED</Badge>}
                    {/* B10: the live stale_prepared flag and the durable review
                        record can disagree (e.g. payment progressed after a
                        review was opened but before anyone resolved it) —
                        both are shown, distinctly labelled, instead of one
                        silently standing in for the other. */}
                    {string(settlement.prepared_review_status) && <Badge>{`REVIEW: ${string(settlement.prepared_review_status)}`}</Badge>}
                  </td>
                  <td>{string(settlement.document_reference) || "—"}<small>recovered: {formatMoney(settlement.recovered_total)}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {selected && <SettlementDetail id={selected} close={() => replaceSelection(null)} />}
    </>
  );
}
