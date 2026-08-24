"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { emailAttentionKeys } from "../../lib/query-keys";
import { POLL_INTERVAL } from "../../lib/polling";
import { number } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Freshness } from "../ui/Freshness";
import { EmailIncidentTable } from "./EmailIncidentTable";
import { EmailAttentionAcknowledgement } from "./EmailAttentionAcknowledgement";

export function EmailAttention() {
  const query = useQuery({
    queryKey: emailAttentionKeys.list(),
    queryFn: () => api<{ incidents: Row[]; attention_count: number }>("/email-attention"),
    refetchInterval: POLL_INTERVAL.emailAttention,
  });
  const [acknowledging, setAcknowledging] = useState<Row | null>(null);

  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS / EMAIL"
        title={<>Email<br /><i>attention.</i></>}
        text="Delivery status — это provider evidence. Acknowledgement означает только review оператором и не отправляет письмо повторно."
      />
      {query.isLoadingError ? <section className="panel"><Notice error={(query.error as { code?: string } | null)?.code ?? "UNKNOWN"} /></section> : !query.data ? <section className="panel"><Loading /></section> : (
        <>
          <section className="panel">
            <h2>Требуют внимания</h2>
            <Freshness query={{ ...query, hasData: Boolean(query.data) }} />
            <p className="notice">Требуют внимания: <strong>{query.data.attention_count}</strong></p>
            <EmailIncidentTable incidents={query.data.incidents.filter((incident) => number(incident.requires_attention) === 1)} acknowledge={setAcknowledging} empty="Нет email-инцидентов, требующих внимания." />
          </section>
          <section className="panel detail">
            <h2>Рассмотренные</h2>
            <EmailIncidentTable incidents={query.data.incidents.filter((incident) => number(incident.requires_attention) === 0)} empty="Рассмотренных email-инцидентов пока нет." />
          </section>
        </>
      )}
      {acknowledging && <EmailAttentionAcknowledgement incident={acknowledging} close={() => setAcknowledging(null)} done={() => setAcknowledging(null)} />}
    </>
  );
}
