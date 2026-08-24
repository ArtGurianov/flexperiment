"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { settlementKeys } from "../../lib/query-keys";
import { POLL_INTERVAL, pollingQuery } from "../../lib/polling";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { EvidenceCard } from "../ui/EvidenceCard";
import { Freshness } from "../ui/Freshness";
import { SettlementAction } from "./SettlementAction";

type SettlementActionKind = "PAYMENT_MADE" | "DOCUMENTS_COMPLETE" | "CANCEL_BEFORE_PAYMENT" | "RECOVERY";

export function SettlementDetail({ id, close }: { id: string; close: () => void }) {
  const detail = useQuery({
    queryKey: settlementKeys.detail(id),
    queryFn: () => api<{ settlement: Row; balance: Row; recoveries: Row[] }>(`/reward-settlements/${id}`),
    ...pollingQuery(POLL_INTERVAL.settlements),
  });
  const [action, setAction] = useState<SettlementActionKind | null>(null);

  if (detail.isLoadingError) return <section className="panel detail"><Notice error={(detail.error as { code?: string } | null)?.code ?? "UNKNOWN"} /></section>;
  if (!detail.data) return <section className="panel detail"><Loading /></section>;
  const settlement = detail.data.settlement;
  const state = string(settlement.status);

  return (
    <section className="panel detail">
      <div className="detail-head">
        <h2>Settlement evidence</h2>
        <button onClick={close}>Закрыть ×</button>
      </div>
      <code>{id}</code>
      <Freshness query={{ ...detail, hasData: Boolean(detail.data) }} />
      <div className="evidence-grid">
        <EvidenceCard title="SETTLEMENT" data={settlement} />
        <EvidenceCard title="BALANCE" data={detail.data.balance} />
        <EvidenceCard title="RECOVERIES" data={detail.data.recoveries} />
      </div>
      <div className="detail-actions">
        {state === "PREPARED" && (
          <>
            <button className="primary" onClick={() => setAction("PAYMENT_MADE")}>Подтвердить перевод</button>
            <button className="danger" onClick={() => setAction("CANCEL_BEFORE_PAYMENT")}>Отменить до оплаты</button>
          </>
        )}
        {state === "PENDING_DOCUMENT" && <button className="primary" onClick={() => setAction("DOCUMENTS_COMPLETE")}>Подтвердить документы</button>}
        {(state === "PENDING_DOCUMENT" || state === "SETTLED") && <button onClick={() => setAction("RECOVERY")}>Зафиксировать recovery</button>}
      </div>
      {action && <SettlementAction action={action} settlement={settlement} close={() => setAction(null)} done={() => setAction(null)} />}
    </section>
  );
}
