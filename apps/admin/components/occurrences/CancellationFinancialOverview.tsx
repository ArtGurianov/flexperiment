"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { occurrenceKeys } from "../../lib/query-keys";
import { POLL_INTERVAL } from "../../lib/polling";
import { formatMoney, number } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Notice } from "../ui/Notice";
import { Freshness } from "../ui/Freshness";

export function CancellationFinancialOverview({ occurrenceId }: { occurrenceId: string }) {
  const overview = useQuery({
    queryKey: occurrenceKeys.cancellationFinancials(occurrenceId),
    queryFn: () => api<Row>(`/occurrences/${occurrenceId}/cancellation-financial-overview`),
    refetchInterval: POLL_INTERVAL.cancellationFinancials,
  });
  if (overview.isLoadingError) return <Notice error={(overview.error as { code?: string } | null)?.code ?? "UNKNOWN"} />;
  if (!overview.data) return <small>Загружаем financial overview…</small>;
  const value = overview.data;
  return (
    <div className="evidence-grid">
      <div className="evidence">
        <h3>ОТМЕНА / ВОЗВРАТЫ</h3>
        <Freshness query={{ ...overview, hasData: Boolean(overview.data) }} />
        <p>Получено: {formatMoney(value.captured_kopecks)}</p>
        <p>К возврату: {formatMoney(value.refund_target_kopecks)}</p>
        <p>Возвращено: {formatMoney(value.refund_succeeded_kopecks)}</p>
        <p>В обработке: {formatMoney(value.refund_outstanding_kopecks)}</p>
        <p>Требует внимания: {formatMoney(value.refund_needs_attention_kopecks)} ({number(value.refund_needs_attention_count)})</p>
      </div>
    </div>
  );
}
