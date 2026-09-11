"use client";

import { useQuery } from "@tanstack/react-query";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import { usePartnerMutation } from "../../lib/use-partner-mutation";
import { partnerKeys } from "../../lib/query-keys";
import type { Row } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";

/** Framework acceptance: mint the exact FRAMEWORK_ACCEPTANCE step-up grant, then accept - the resource hash must match agent-referrals-framework-acceptance.ts's own byte for byte. */
export function Agreement() {
  const agreements = useQuery({ queryKey: partnerKeys.agreements(), queryFn: () => partnerApi<Row>("/agreements") });

  if (agreements.isLoading) return <Loading />;
  if (agreements.isError) return <Notice error={(agreements.error as PartnerApiError).code} />;
  const data = agreements.data!;

  if (!data.issued) {
    return <PageTitle eyebrow="ДОГОВОР" title="Договор" text="Договор ещё не выдан администратором." />;
  }

  const agreement = data.framework_agreement as Row | null;
  const delegationTemplate = data.delegation_template as Row | null;
  const frameworkAgreementRevisionId = String(data.framework_agreement_revision_id ?? "");
  const delegationTemplateRevisionId = String(data.delegation_template_revision_id ?? "");

  return (
    <>
      <PageTitle eyebrow="ДОГОВОР" title="Договор и делегирование ОРД" text="Ознакомьтесь и примите текущую редакцию." />
      <section className="card">
        <h2>Договор (ред. {String(agreement?.revision ?? "—")})</h2>
        <pre className="agreement-content">{JSON.stringify(agreement?.content ?? {}, null, 2)}</pre>
      </section>
      <section className="card">
        <h2>Делегирование ОРД (ред. {String(delegationTemplate?.revision ?? "—")})</h2>
        <pre className="agreement-content">{JSON.stringify(delegationTemplate?.content ?? {}, null, 2)}</pre>
      </section>
      {data.accepted ? (
        <Notice><>Принято {String(data.accepted_at)}.</></Notice>
      ) : (
        <AcceptForm
          frameworkAgreementRevisionId={frameworkAgreementRevisionId}
          delegationTemplateRevisionId={delegationTemplateRevisionId}
        />
      )}
      {Boolean(data.delegation_revoked) && <Notice><>Делегирование отозвано {String(data.delegation_revoked_at)}.</></Notice>}
    </>
  );
}

function AcceptForm({ frameworkAgreementRevisionId, delegationTemplateRevisionId }: {
  frameworkAgreementRevisionId: string; delegationTemplateRevisionId: string;
}) {
  // Grant mint and acceptance are one intent (see Payout's own note): the
  // grant is bound to this exact revision pair, so the pair is derived once
  // and used for both calls.
  const accept = usePartnerMutation("partner.frameworkAccept", async () => {
    const resource = { framework_agreement_revision_id: frameworkAgreementRevisionId, delegation_template_revision_id: delegationTemplateRevisionId };
    const { grant_id } = await partnerApi<{ grant_id: string }>("/step-up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "FRAMEWORK_ACCEPTANCE", resource }),
    });
    return partnerApi("/framework/accept", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step_up_grant_id: grant_id, ...resource }),
    });
  });

  return (
    <section className="card">
      <button className="primary" disabled={accept.isPending} onClick={() => void accept.mutateAsync(undefined).catch(() => undefined)}>
        {accept.isPending ? "Принимаем…" : "Принять договор и делегирование"}
      </button>
      <Notice error={accept.error?.code ?? null} />
    </section>
  );
}
