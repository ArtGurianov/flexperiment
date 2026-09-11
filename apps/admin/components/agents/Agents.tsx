"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { agentKeys } from "../../lib/query-keys";
import { number, string } from "../../lib/values";
import { parsePercentToBasisPoints, formatBasisPoints } from "../../lib/percent";
import { MoneyInput } from "../ui/MoneyInput";
import { PercentInput } from "../ui/PercentInput";
import { parseRublesToKopecks } from "../../../../lib/money";
import type { Row } from "../../lib/page";
import { Badge } from "../ui/Badge";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";

/**
 * PR-A read/write split. `contractor_type` is THREE-valued on the way in
 * (an agent governed by an Agent Referrals legal profile projects to
 * ORGANIZATION) and TWO-valued on the way out (the legacy create command is
 * the only writer that still names it, and only for an agent no profile
 * governs yet). legal_name/inn are the same story since PR-E: for a
 * governed agent they are the profile's own requisites, not this form's
 * fields. So a governed agent's legal identity is rendered read-only and is
 * absent from the PATCH body entirely - the server refuses those fields
 * anyway (AGENT_REFERRALS_*_PROJECTION_LOCKED), and a form that offers to
 * write them would just be the old dual-authority bug with a nicer label.
 */
type ProjectedContractorType = "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR" | "ORGANIZATION";
type LegacyContractorType = "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR";
type LegalProfileView = {
  id: string; revision: number; legal_form: string; tax_mode: string; projected_contractor_type: ProjectedContractorType;
  opf: string | null; full_name: string; short_name: string | null; inn: string; kpp: string | null;
  registration_number: string | null; legal_address: string | null;
};

const CONTRACTOR_TYPE_LABELS: Record<string, string> = { SELF_EMPLOYED: "Самозанятый", INDIVIDUAL_ENTREPRENEUR: "ИП", ORGANIZATION: "Юридическое лицо" };
/** "Юридическое лицо · ООО": the contractor type is the domain class, the ОПФ is the concrete legal form - never conflated into one enum value. */
function contractorTypeLabel(contractorType: string, opf: string | null | undefined): string {
  const base = CONTRACTOR_TYPE_LABELS[contractorType] ?? contractorType;
  return opf ? `${base} · ${opf}` : base;
}
const legalProfileOf = (agent: Row): LegalProfileView | null => (agent.legal_profile as LegalProfileView | null) ?? null;

type AgentInput = { slug: string; display_name: string; legal_name: string; email: string; contractor_type: LegacyContractorType; inn: string; contract_reference: string; enabled: boolean; default_reward_type: "PERCENT" | "FIXED"; default_reward_value: number };
/** What the editor may send for an agent whose legal identity is projected: operational fields only. */
type AgentOperationalPatch = Pick<AgentInput, "display_name" | "email" | "contract_reference" | "enabled" | "default_reward_type" | "default_reward_value">;
type AgentLegacyPatch = Omit<AgentInput, "slug">;
type AgentFormValues = AgentInput & { percent: string; fixedRubles: string };
const defaults: AgentInput = { slug: "", display_name: "", legal_name: "", email: "", contractor_type: "SELF_EMPLOYED", inn: "", contract_reference: "", enabled: true, default_reward_type: "PERCENT", default_reward_value: 0 };

function agentFormDefaults(initial: AgentInput): AgentFormValues {
  return { slug: initial.slug, display_name: initial.display_name, legal_name: initial.legal_name, email: initial.email, contractor_type: initial.contractor_type, inn: initial.inn, contract_reference: initial.contract_reference, enabled: initial.enabled, default_reward_type: initial.default_reward_type, default_reward_value: initial.default_reward_value, percent: initial.default_reward_type === "PERCENT" ? formatBasisPoints(initial.default_reward_value).replace("%", "") : "", fixedRubles: initial.default_reward_type === "FIXED" ? (initial.default_reward_value / 100).toFixed(2).replace(".", ",") : "" };
}
function agentCommand(value: AgentFormValues, amount: number, immutableSlug: boolean, projected: boolean): AgentInput | AgentLegacyPatch | AgentOperationalPatch {
  const operational: AgentOperationalPatch = { display_name: value.display_name, email: value.email, contract_reference: value.contract_reference, enabled: value.enabled, default_reward_type: value.default_reward_type, default_reward_value: amount };
  if (projected) return operational;
  const mutable: AgentLegacyPatch = { ...operational, legal_name: value.legal_name, contractor_type: value.contractor_type, inn: value.inn };
  return immutableSlug ? mutable : { slug: value.slug, ...mutable };
}

/** The projected legal identity, shown as evidence rather than as fields: this is what the partner's own legal profile says, and /agents is not where it changes. */
function ProjectedLegalIdentity({ contractorType, profile }: { contractorType: string; profile: LegalProfileView }) {
  return <div className="readonly-block">
    <p>Тип исполнителя: <strong>{contractorTypeLabel(contractorType, profile.opf)}</strong></p>
    <p><small>Источник: юридический профиль партнёра (ревизия {profile.revision}). Изменяется через смену юридических данных партнёра, не здесь.</small></p>
    <p>Наименование: <strong>{profile.opf ? `${profile.opf} ` : ""}{profile.full_name}{profile.short_name ? ` (${profile.short_name})` : ""}</strong></p>
    <p>ИНН: <strong>{profile.inn}</strong>{profile.kpp ? <> · КПП: <strong>{profile.kpp}</strong></> : null}</p>
    {profile.legal_address ? <p>Юридический адрес: {profile.legal_address}</p> : null}
  </div>;
}

function AgentForm({ initial = defaults, immutableSlug = false, legalProfile = null, contractorType, submit, pending, error }: { initial?: AgentInput; immutableSlug?: boolean; legalProfile?: LegalProfileView | null; contractorType?: string; submit: (value: AgentInput | AgentLegacyPatch | AgentOperationalPatch) => Promise<void>; pending: boolean; error?: string }) {
  const { register, handleSubmit, watch, control } = useForm<AgentFormValues>({ defaultValues: agentFormDefaults(initial) });
  const rewardType = watch("default_reward_type");
  const projected = legalProfile !== null;
  return <form className="form" onSubmit={handleSubmit(async (value) => { const amount = rewardType === "PERCENT" ? parsePercentToBasisPoints(value.percent) : parseRublesToKopecks(value.fixedRubles); if (amount === null || amount < 0) return; try { await submit(agentCommand(value, amount, immutableSlug, projected)); } catch { /* visible below */ } })}>
    <label>Slug <input {...register("slug", { required: true })} readOnly={immutableSlug} /></label>
    <label>Отображаемое имя <input {...register("display_name", { required: true })} /></label>
    {projected
      ? <ProjectedLegalIdentity contractorType={contractorType ?? legalProfile!.projected_contractor_type} profile={legalProfile!} />
      : <>
        <label>Юридическое имя <input {...register("legal_name", { required: true })} /></label>
        <label>ИНН <input inputMode="numeric" {...register("inn", { required: true })} /></label>
        <label>Тип исполнителя <select {...register("contractor_type")}><option value="SELF_EMPLOYED">Самозанятый</option><option value="INDIVIDUAL_ENTREPRENEUR">ИП</option></select></label>
      </>}
    <label>Email <input type="email" {...register("email", { required: true })} /></label>
    <label>Договор <input {...register("contract_reference", { required: true })} /></label>
    <label>Тип вознаграждения <select {...register("default_reward_type")}><option value="PERCENT">Процент</option><option value="FIXED">Фиксированное</option></select></label>
    {rewardType === "PERCENT" ? <label>Процент <Controller control={control} name="percent" rules={{ required: true }} render={({ field }) => <PercentInput value={field.value} onChange={field.onChange} minBasisPoints={0} />} /></label> : <label>Вознаграждение, ₽<Controller control={control} name="fixedRubles" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} required />} /></label>}
    <label className="checkbox-field"><input type="checkbox" {...register("enabled")} aria-describedby="agent-enabled-help" /><span><strong>Агент активен</strong><small id="agent-enabled-help">Отключённый агент не получает новые attribution через промокоды и referral links. История заказов сохраняется.</small></span></label>
    <Notice error={error} /><button className="primary" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
  </form>;
}

export function Agents() {
  const agents = useQuery({ queryKey: agentKeys.list(), queryFn: () => api<{ agents: Row[] }>("/agents") });
  const createKey = usePersistentIdempotencyKey(); const editKey = usePersistentIdempotencyKey();
  // PR-C: the open editor holds an ID, not a snapshot of the row. Holding
  // the row meant an agent that became governed while its dialog was open
  // kept rendering the pre-governance form: useAdminMutation's authoritative
  // refetch updated the list behind it, the dialog did not, and the new
  // error hint told the operator "карточка перечитана" while the card in
  // front of them was the stale one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const create = useAdminMutation("agent.create", ({ body, key }: { body: AgentInput; key: string }) => api("/agents", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const patch = useAdminMutation("agent.patch", ({ id, body, key }: { id: string; body: AgentLegacyPatch | AgentOperationalPatch; key: string }) => api(`/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), { context: (input) => ({ agentId: input.id }) });
  const editing = agents.data?.agents.find((agent) => string(agent.id) === editingId) ?? null;
  const editingProfile = editing ? legalProfileOf(editing) : null;
  return <><PageTitle eyebrow="COMMERCE / ATTRIBUTION" title={<>Агенты<br /><i>и промо.</i></>} text="Slug — immutable human-readable handle; agents.id is the local identity. All writes are idempotent audited commands." />
    <section className="two-col catalog-grid"><Panel title="Агенты">{agents.isLoadingError ? <Notice error={(agents.error as { code?: string }).code} /> : !agents.data ? <Loading /> : <table><thead><tr><th>Агент</th><th>Тип</th><th>Статус</th><th>Промо</th><th /></tr></thead><tbody>{agents.data.agents.map((agent) => <tr key={string(agent.id)}><td><strong>{string(agent.display_name)}</strong><small>{string(agent.slug)}</small></td><td>{contractorTypeLabel(string(agent.contractor_type), legalProfileOf(agent)?.opf)}{string(agent.contractor_type_source) === "LEGAL_PROFILE" ? <><br /><Badge>юр. профиль</Badge></> : null}</td><td>{Number(agent.enabled) ? "Активен" : "Отключён"}</td><td>{number(agent.promo_count)}</td><td><button onClick={() => setEditingId(string(agent.id))}>Редактировать</button></td></tr>)}</tbody></table>}</Panel>
    <Panel title="Добавить агента"><AgentForm submit={async (body) => { await create.mutateAsync({ body: body as AgentInput, key: createKey.acquire() }); createKey.clear(); }} pending={create.isPending} error={create.error?.code} /></Panel></section>
    {editing ? <Dialog title="Редактировать агента" close={() => setEditingId(null)} className="editor"><AgentForm immutableSlug legalProfile={editingProfile} contractorType={string(editing.contractor_type)} initial={{ slug: string(editing.slug), display_name: string(editing.display_name), legal_name: string(editing.legal_name), email: string(editing.email), contractor_type: string(editing.contractor_type) as LegacyContractorType, inn: string(editing.inn), contract_reference: string(editing.contract_reference), enabled: Number(editing.enabled) === 1, default_reward_type: string(editing.default_reward_type) as AgentInput["default_reward_type"], default_reward_value: number(editing.default_reward_value) }} submit={async (body) => { await patch.mutateAsync({ id: string(editing.id), body: body as AgentLegacyPatch | AgentOperationalPatch, key: editKey.acquire() }); editKey.clear(); setEditingId(null); }} pending={patch.isPending} error={patch.error?.code} /></Dialog> : null}</>;
}
