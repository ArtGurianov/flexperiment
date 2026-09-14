"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import { usePartnerMutation } from "../../lib/use-partner-mutation";
import { partnerKeys } from "../../lib/query-keys";
import type { Row } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Dialog } from "../ui/Dialog";
import { buildAgreementSemanticView, type AgreementLegalProfileLike, type AgreementSemanticView } from "./AgreementRenderer";

/**
 * PR3 of the reissuance/evidence program: a semantic three-part renderer
 * (parties/requisites -> terms -> evidence footer) replacing the old raw
 * `JSON.stringify(content)` dump, an explicit "Я ознакомился" checkbox, a
 * confirmation dialog naming both revisions/hashes and stating the record
 * is permanent, and a post-acceptance evidence panel. Step-up + accept
 * happen only from "Подтвердить" inside the dialog - never the checkbox
 * itself.
 */
export function Agreement() {
  const agreements = useQuery({ queryKey: partnerKeys.agreements(), queryFn: () => partnerApi<Row>("/agreements") });
  const profile = useQuery({ queryKey: partnerKeys.me(), queryFn: () => partnerApi<Row>("/me") });

  if (agreements.isLoading || profile.isLoading) return <Loading />;
  if (agreements.isError) return <Notice error={(agreements.error as PartnerApiError).code} />;
  if (profile.isError) return <Notice error={(profile.error as PartnerApiError).code} />;
  const data = agreements.data!;

  if (!data.issued) {
    return <PageTitle eyebrow="ДОГОВОР" title="Договор" text="Договор ещё не выдан администратором." />;
  }

  const accepted = Boolean(data.accepted);
  const currentLegalProfile = profile.data!.legal_profile as (AgreementLegalProfileLike & { id?: string }) | null;
  const acceptedLegalProfile = data.accepted_legal_profile as AgreementLegalProfileLike | null;
  const partyProfile = accepted ? acceptedLegalProfile : currentLegalProfile;

  if (!partyProfile) {
    // Structural: an issuance always implies a verified legal profile, and
    // an acceptance always pins one. Reaching here means the server's own
    // invariant broke - render nothing rather than a confusing blank form.
    return <Notice error="AGREEMENT_PARTY_PROFILE_MISSING" />;
  }

  const view = buildAgreementSemanticView({
    issuance_sequence: Number(data.issuance_sequence ?? 0),
    issued_at: String(data.issued_at ?? ""),
    framework_agreement: {
      revision: Number((data.framework_agreement as Row | null)?.revision ?? 0),
      content_hash: String((data.framework_agreement as Row | null)?.content_hash ?? ""),
      content: (data.framework_agreement as Row | null)?.content,
    },
    delegation_template: {
      revision: Number((data.delegation_template as Row | null)?.revision ?? 0),
      content_hash: String((data.delegation_template as Row | null)?.content_hash ?? ""),
      content: (data.delegation_template as Row | null)?.content,
    },
    accepted,
    accepted_at: data.accepted_at ? String(data.accepted_at) : null,
    party_profile: partyProfile,
    // NOTICE_ONLY divergence: the agreement stays CURRENT even though the
    // current MAX profile differs from what was accepted by a non-
    // contractual fact (address, kpp, name spelling, ...) - shown as a
    // notice, never a status change. Detected here by comparing the two
    // already-fetched profile snapshots at the field level (never
    // re-deriving CONTRACTUAL_REISSUANCE_REQUIRED client-side - that
    // classification belongs solely to agent-referrals-legal-profile.ts;
    // agreement_status === "CURRENT" already proves any divergence here is
    // NOTICE_ONLY, since the server would have reported REISSUANCE_REQUIRED
    // otherwise).
    notice_only_divergence_since_acceptance: accepted && currentLegalProfile !== null && acceptedLegalProfile !== null
      && JSON.stringify(currentLegalProfile) !== JSON.stringify(acceptedLegalProfile),
  });

  const issuanceId = String(data.issuance_id ?? "");
  const legalProfileRevisionId = String((accepted ? data.accepted_legal_profile_revision_id : data.current_legal_profile_revision_id) ?? "");
  const agreementStatus = String(data.agreement_status ?? "");

  return (
    <>
      <PageTitle eyebrow="ДОГОВОР" title="Договор и делегирование ОРД" text="Ознакомьтесь и примите текущую редакцию." />
      <AgreementSections view={view} />
      {accepted ? (
        <AcceptedEvidencePanel view={view} />
      ) : (
        <AcceptFlow issuanceId={issuanceId} legalProfileRevisionId={legalProfileRevisionId} view={view} />
      )}
      {view.noticeOnlyProfileDivergence && (
        <Notice><>Реквизиты, указанные при заключении договора, впоследствии обновлены (не влияет на действие договора).</></Notice>
      )}
      {agreementStatus === "REISSUANCE_REQUIRED" && <Notice><>Реквизиты изменились - требуется новая редакция от администратора.</></Notice>}
      {agreementStatus === "REACCEPTANCE_REQUIRED" && <Notice><>Выдана новая редакция - требуется повторное принятие.</></Notice>}
      {Boolean(data.delegation_revoked) && <Notice><>Делегирование отозвано {String(data.delegation_revoked_at)}.</></Notice>}
    </>
  );
}

const PARTY_LABEL: Record<string, string> = { INDIVIDUAL: "Физическое лицо", INDIVIDUAL_ENTREPRENEUR: "Индивидуальный предприниматель", LEGAL_ENTITY: "Юридическое лицо" };

function AgreementSections({ view }: { view: AgreementSemanticView }) {
  return (
    <>
      <section className="card">
        <h2>Стороны</h2>
        <p>{PARTY_LABEL[view.party.legal_form] ?? view.party.legal_form}{view.party.opf ? ` · ${view.party.opf}` : ""}</p>
        <p><strong>{view.party.full_name}</strong>{view.party.short_name ? ` (${view.party.short_name})` : ""}</p>
        <p>ИНН {view.party.inn}{view.party.kpp ? ` · КПП ${view.party.kpp}` : ""}{view.party.registration_number ? ` · Рег. номер ${view.party.registration_number}` : ""}</p>
        {view.party.legal_address && <p>{view.party.legal_address}</p>}
      </section>
      <section className="card">
        <h2>Условия договора (ред. {view.evidence.framework_agreement_revision})</h2>
        <ol className="agreement-clauses">
          {view.framework_clauses.map((clause) => <li key={clause.key}><strong>{clause.label}.</strong> {clause.text}</li>)}
        </ol>
      </section>
      <section className="card">
        <h2>Делегирование ОРД (ред. {view.evidence.delegation_template_revision})</h2>
        <ol className="agreement-clauses">
          {view.delegation_clauses.map((clause) => <li key={clause.key}><strong>{clause.label}.</strong> {clause.text}</li>)}
        </ol>
      </section>
    </>
  );
}

function EvidenceFooter({ view }: { view: AgreementSemanticView }) {
  return (
    <dl className="agreement-evidence">
      <dt>Редакция договора</dt><dd>{view.evidence.framework_agreement_revision} · {view.evidence.framework_agreement_content_hash}</dd>
      <dt>Редакция делегирования ОРД</dt><dd>{view.evidence.delegation_template_revision} · {view.evidence.delegation_template_content_hash}</dd>
      <dt>Редакция юридического профиля</dt><dd>{view.evidence.legal_profile_revision}</dd>
      <dt>Выдано</dt><dd>{view.evidence.issued_at}</dd>
      {view.evidence.accepted_at && <><dt>Принято</dt><dd>{view.evidence.accepted_at}</dd></>}
    </dl>
  );
}

function AcceptedEvidencePanel({ view }: { view: AgreementSemanticView }) {
  return (
    <section className="card">
      <h2>Договор принят</h2>
      <EvidenceFooter view={view} />
    </section>
  );
}

function AcceptFlow({ issuanceId, legalProfileRevisionId, view }: { issuanceId: string; legalProfileRevisionId: string; view: AgreementSemanticView }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const accept = usePartnerMutation("partner.frameworkAccept", async () => {
    const resource = { issuance_id: issuanceId, legal_profile_revision_id: legalProfileRevisionId };
    const { grant_id } = await partnerApi<{ grant_id: string }>("/step-up", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "FRAMEWORK_ACCEPTANCE", resource }),
    });
    return partnerApi("/framework/accept", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step_up_grant_id: grant_id, ...resource }),
    });
  });

  const confirm = async () => {
    await accept.mutateAsync(undefined).then(() => setConfirming(false)).catch(() => undefined);
  };

  return (
    <section className="card">
      <label className="checkbox-field">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>Я ознакомился с условиями договора и делегирования ОРД, приведёнными выше.</span>
      </label>
      <button className="primary" disabled={!acknowledged} onClick={() => setConfirming(true)}>Принять договор и делегирование</button>
      <Notice error={accept.error?.code ?? null} />
      {confirming && (
        <Dialog title="Подтверждение принятия договора" close={() => setConfirming(false)}>
          <h2>Подтвердите принятие</h2>
          <p>Вы принимаете договор ред. {view.evidence.framework_agreement_revision} (хеш {view.evidence.framework_agreement_content_hash}) и делегирование ОРД ред. {view.evidence.delegation_template_revision} (хеш {view.evidence.delegation_template_content_hash}) для юридического профиля ред. {view.evidence.legal_profile_revision}.</p>
          <p><strong>Эта запись будет постоянной и не может быть отменена.</strong></p>
          <button className="primary" disabled={accept.isPending} onClick={() => void confirm()}>{accept.isPending ? "…" : "Подтвердить"}</button>
          <button onClick={() => setConfirming(false)}>Отмена</button>
          <Notice error={accept.error?.code ?? null} />
        </Dialog>
      )}
    </section>
  );
}
