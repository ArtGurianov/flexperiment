"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, AdminApiError } from "../../lib/api";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

const REVIEW_QUEUE_LABELS: Record<string, string> = {
  distributions_review_required: "Размещения, требующие проверки канала",
  distributions_removal_overdue: "Просроченное/неподтверждённое снятие",
  distributions_reporting_tail_incomplete: "Незавершённая ОРД-отчётность",
  acts_awaiting_presentation: "Акты, ожидающие предъявления",
  payment_attempts_payout_unknown: "Выплаты с неизвестным статусом",
  npd_reconciliation_needed: "Требуется свежая проверка НПД",
  partners_profile_pending_verification: "Партнёры: профиль ожидает проверки",
  partners_framework_not_issued: "Партнёры: договор не выдан",
};

/** §11 operator review reminders (Phase 9 round-2 fix): the same live-derived read the worker logs a summary of every cycle. */
export function Overview() {
  const featureState = useQuery({ queryKey: ["agent-referrals", "feature-state"], queryFn: () => api<Row>("/agent-referrals/feature-state") });
  const reviewQueue = useQuery({ queryKey: ["agent-referrals", "review-queue"], queryFn: () => api<Record<string, string[]>>("/agent-referrals/review-queue") });
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-referrals", "feature-state"] });

  const transition = async (action: "suspend" | "reactivate") => {
    if (!featureState.data) return;
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/feature-state/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: featureState.data.revision, reason: `admin console: ${action}` }),
      });
      refresh();
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel title="Состояние функции">
        {featureState.isLoading ? <Loading /> : featureState.isError ? <Notice error={(featureState.error as AdminApiError).code} /> : (
          <>
            <p>Статус: <Badge>{String(featureState.data!.state)}</Badge></p>
            {featureState.data!.state === "ACTIVE" && <button disabled={busy} onClick={() => void transition("suspend")}>{busy ? "…" : "Приостановить (SUSPENDED)"}</button>}
            {featureState.data!.state === "SUSPENDED" && <button disabled={busy} onClick={() => void transition("reactivate")}>{busy ? "…" : "Возобновить (ACTIVE)"}</button>}
            {featureState.data!.state === "DORMANT" && <p>Активация выполняется только через контролируемый релизный процесс (Phase 10B), не из этой консоли.</p>}
            <Notice error={error} />
          </>
        )}
      </Panel>

      <Panel title="Очередь проверки оператора">
        {reviewQueue.isLoading ? <Loading /> : reviewQueue.isError ? <Notice error={(reviewQueue.error as AdminApiError).code} /> : (
          <table>
            <thead><tr><th>Категория</th><th>Количество</th></tr></thead>
            <tbody>
              {Object.entries(reviewQueue.data!).map(([key, ids]) => (
                <tr key={key}>
                  <td>{REVIEW_QUEUE_LABELS[key] ?? key}</td>
                  <td><Badge>{ids.length}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
