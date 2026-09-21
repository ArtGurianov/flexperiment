"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { agentKeys } from "../../lib/query-keys";
import { number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";

type ProjectedContractorType = "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR" | "ORGANIZATION";
type LegalProfileView = { revision: number; projected_contractor_type: ProjectedContractorType; opf: string | null };

const CONTRACTOR_TYPE_LABELS: Record<ProjectedContractorType, string> = {
  SELF_EMPLOYED: "Самозанятый",
  INDIVIDUAL_ENTREPRENEUR: "ИП",
  ORGANIZATION: "Юридическое лицо",
};
const legalProfileOf = (agent: Row): LegalProfileView | null => (agent.legal_profile as LegalProfileView | null) ?? null;
const legalIdentityLabel = (profile: LegalProfileView | null): string => {
  if (!profile) return "Не указан";
  const label = CONTRACTOR_TYPE_LABELS[profile.projected_contractor_type];
  return profile.opf ? `${label} · ${profile.opf}` : label;
};

type AgreementStatus = "NOT_ISSUED" | "INITIAL_ACCEPTANCE_REQUIRED" | "CURRENT" | "REISSUANCE_REQUIRED" | "REACCEPTANCE_REQUIRED";
type AgreementView = { status: AgreementStatus; accepted_framework_agreement_revision: number | null; partner_identity_id: string };

/** PR4 of the reissuance/evidence program: the "Договор" column - never conflated with the legal-identity column above, which is about contractor_type, not agreement authority. */
const AGREEMENT_STATUS_LABELS: Record<AgreementStatus, string> = {
  NOT_ISSUED: "не выдан",
  INITIAL_ACCEPTANCE_REQUIRED: "ожидает акцепта",
  CURRENT: "принят",
  REISSUANCE_REQUIRED: "требуется перевыдача",
  REACCEPTANCE_REQUIRED: "требуется переакцепт",
};
const agreementOf = (agent: Row): AgreementView | null => (agent.agreement as AgreementView | null) ?? null;
const agreementLabel = (agreement: AgreementView | null): string => {
  if (!agreement) return "—";
  const label = AGREEMENT_STATUS_LABELS[agreement.status];
  return agreement.status === "CURRENT" && agreement.accepted_framework_agreement_revision !== null ? `${label} ред. ${agreement.accepted_framework_agreement_revision}` : label;
};

type AgentInput = {
  slug: string;
  display_name: string;
  email: string;
  enabled: boolean;
};
type AgentPatch = Omit<AgentInput, "slug">;
const defaults: AgentInput = { slug: "", display_name: "", email: "", enabled: true };

function agentCommand(value: AgentInput, immutableSlug: boolean): AgentInput | AgentPatch {
  const operational: AgentPatch = {
    display_name: value.display_name,
    email: value.email,
    enabled: value.enabled,
  };
  return immutableSlug ? operational : { slug: value.slug, ...operational };
}

function AgentForm({ initial = defaults, immutableSlug = false, submit, pending, error }: { initial?: AgentInput; immutableSlug?: boolean; submit: (value: AgentInput | AgentPatch) => Promise<void>; pending: boolean; error?: string }) {
  const { register, handleSubmit } = useForm<AgentInput>({ defaultValues: initial });
  return <form className="form" onSubmit={handleSubmit(async (value) => {
    try { await submit(agentCommand(value, immutableSlug)); } catch { /* visible below */ }
  })}>
    <label>Slug <input {...register("slug", { required: true })} readOnly={immutableSlug} /></label>
    <label>Отображаемое имя <input {...register("display_name", { required: true })} /></label>
    <label>Email <input type="email" {...register("email", { required: true })} /></label>
    <label className="checkbox-field"><input type="checkbox" {...register("enabled")} aria-describedby="agent-enabled-help" /><span><strong>Агент активен</strong><small id="agent-enabled-help">Отключённый агент не получает новые attribution через промокоды и referral links. История заказов сохраняется.</small></span></label>
    <Notice error={error} /><button className="primary" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
  </form>;
}

export function Agents() {
  const agents = useQuery({ queryKey: agentKeys.list(), queryFn: () => api<{ agents: Row[] }>("/agents") });
  const createKey = usePersistentIdempotencyKey();
  const editKey = usePersistentIdempotencyKey();
  const [editingId, setEditingId] = useState<string | null>(null);
  const create = useAdminMutation("agent.create", ({ body, key }: { body: AgentInput; key: string }) => api("/agents", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const patch = useAdminMutation("agent.patch", ({ id, body, key }: { id: string; body: AgentPatch; key: string }) => api(`/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), { context: (input) => ({ agentId: input.id }) });
  const editing = agents.data?.agents.find((agent) => string(agent.id) === editingId) ?? null;
  return <><PageTitle eyebrow="COMMERCE / ATTRIBUTION" title={<>Агенты<br /><i>и промо.</i></>} text="Slug — immutable human-readable handle; agents.id is the local identity. Legal identity is read-only and managed through partner onboarding." />
    <section className="two-col catalog-grid"><Panel title="Агенты">{agents.isLoadingError ? <Notice error={(agents.error as { code?: string }).code} /> : !agents.data ? <Loading /> : <table><thead><tr><th>Агент</th><th>Юридический статус</th><th>Договор</th><th>Статус</th><th>Промо</th><th /></tr></thead><tbody>{agents.data.agents.map((agent) => { const agreement = agreementOf(agent); return <tr key={string(agent.id)}><td><strong>{string(agent.display_name)}</strong><small>{string(agent.slug)}</small></td><td>{legalIdentityLabel(legalProfileOf(agent))}</td><td>{agreement ? <a href={`/agent-referrals?tab=partners&id=${agreement.partner_identity_id}`}>{agreementLabel(agreement)}</a> : agreementLabel(agreement)}</td><td>{Number(agent.enabled) ? "Активен" : "Отключён"}</td><td>{number(agent.promo_count)}</td><td><button onClick={() => setEditingId(string(agent.id))}>Редактировать</button></td></tr>; })}</tbody></table>}</Panel>
    <Panel title="Добавить агента"><AgentForm submit={async (body) => { await create.mutateAsync({ body: body as AgentInput, key: createKey.acquire() }); createKey.clear(); }} pending={create.isPending} error={create.error?.code} /></Panel></section>
    {editing ? <Dialog title="Редактировать агента" close={() => setEditingId(null)} className="editor"><AgentForm immutableSlug initial={{ slug: string(editing.slug), display_name: string(editing.display_name), email: string(editing.email), enabled: Number(editing.enabled) === 1 }} submit={async (body) => { await patch.mutateAsync({ id: string(editing.id), body: body as AgentPatch, key: editKey.acquire() }); editKey.clear(); setEditingId(null); }} pending={patch.isPending} error={patch.error?.code} /></Dialog> : null}</>;
}
