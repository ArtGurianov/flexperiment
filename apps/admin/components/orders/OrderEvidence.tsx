"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { orderKeys } from "../../lib/query-keys";
import { POLL_INTERVAL } from "../../lib/polling";
import { number } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { EvidenceCard } from "../ui/EvidenceCard";
import { Freshness } from "../ui/Freshness";
import { RefundAction } from "./RefundAction";
import { AbandonAction } from "./AbandonAction";

export function OrderEvidence({ id, close }: { id: string; close: () => void }) {
  const evidence = useQuery({
    queryKey: orderKeys.evidence(id),
    queryFn: () => api<Row>(`/orders/${id}/evidence`),
    refetchInterval: POLL_INTERVAL.orderEvidence,
  });
  const [showRefund, setShowRefund] = useState(false);
  const [showAbandon, setShowAbandon] = useState(false);

  if (evidence.isLoadingError) return <section className="panel detail"><Notice error={(evidence.error as { code?: string } | null)?.code ?? "UNKNOWN"} /></section>;
  if (!evidence.data) return <section className="panel detail"><Loading /></section>;
  const data = evidence.data;
  const actions = data.actions as Row | undefined;
  const refunds = Array.isArray(data.refunds) ? data.refunds as Row[] : [];
  const unavailable = refunds
    .filter((refund) => ["SUCCEEDED", "REQUESTED", "SUBMITTING", "SUBMIT_UNKNOWN", "RECONCILING"].includes(String(refund.status)))
    .reduce((total, refund) => total + number(refund.amount_kopecks), 0);
  const availableRefund = Math.max(0, number((data.payment as Row | null)?.captured_amount_kopecks) - unavailable);

  return (
    <section className="panel detail">
      <div className="detail-head">
        <h2>Order evidence</h2>
        <button onClick={close}>Закрыть ×</button>
      </div>
      <code>{id}</code>
      <Freshness query={{ ...evidence, hasData: Boolean(evidence.data) }} />
      <div className="evidence-grid">
        <EvidenceCard title="ORDER" data={data.order} />
        <EvidenceCard title="PAYMENT" data={data.payment} />
        <EvidenceCard title="BOOKING" data={data.booking} />
        <EvidenceCard title="TICKET" data={data.ticket} />
        <EvidenceCard title="EMAIL" data={data.email_outbox} />
        <EvidenceCard title="REFUNDS" data={data.refunds} />
        <EvidenceCard title="RESERVATION RECOVERY" data={data.reservation_abandonment} />
      </div>
      <div className="detail-actions">
        {actions?.can_create_compensation_refund === true && <button className="primary" onClick={() => setShowRefund(true)}>Вернуть оплату</button>}
        {actions?.can_abandon_reservation === true && <button className="danger" onClick={() => setShowAbandon(true)}>Technical abandonment</button>}
      </div>
      {showRefund && <RefundAction orderId={id} max={availableRefund} close={() => setShowRefund(false)} />}
      {showAbandon && <AbandonAction orderId={id} close={() => setShowAbandon(false)} />}
    </section>
  );
}
