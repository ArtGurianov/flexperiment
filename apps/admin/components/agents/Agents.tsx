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
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";

type AgentInput = { slug: string; display_name: string; legal_name: string; email: string; contractor_type: "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR"; inn: string; contract_reference: string; enabled: boolean; default_reward_type: "PERCENT" | "FIXED"; default_reward_value: number };
type AgentFormValues = AgentInput & { percent: string; fixedRubles: string };
const defaults: AgentInput = { slug: "", display_name: "", legal_name: "", email: "", contractor_type: "SELF_EMPLOYED", inn: "", contract_reference: "", enabled: true, default_reward_type: "PERCENT", default_reward_value: 0 };

function agentFormDefaults(initial: AgentInput): AgentFormValues {
  return { slug: initial.slug, display_name: initial.display_name, legal_name: initial.legal_name, email: initial.email, contractor_type: initial.contractor_type, inn: initial.inn, contract_reference: initial.contract_reference, enabled: initial.enabled, default_reward_type: initial.default_reward_type, default_reward_value: initial.default_reward_value, percent: initial.default_reward_type === "PERCENT" ? formatBasisPoints(initial.default_reward_value).replace("%", "") : "", fixedRubles: initial.default_reward_type === "FIXED" ? (initial.default_reward_value / 100).toFixed(2).replace(".", ",") : "" };
}
function agentCommand(value: AgentFormValues, amount: number, immutableSlug: boolean): AgentInput | Omit<AgentInput, "slug"> {
  const mutable = { display_name: value.display_name, legal_name: value.legal_name, email: value.email, contractor_type: value.contractor_type, inn: value.inn, contract_reference: value.contract_reference, enabled: value.enabled, default_reward_type: value.default_reward_type, default_reward_value: amount };
  return immutableSlug ? mutable : { slug: value.slug, ...mutable };
}
function AgentForm({ initial = defaults, immutableSlug = false, submit, pending, error }: { initial?: AgentInput; immutableSlug?: boolean; submit: (value: AgentInput | Omit<AgentInput, "slug">) => Promise<void>; pending: boolean; error?: string }) {
  const { register, handleSubmit, watch, control } = useForm<AgentFormValues>({ defaultValues: agentFormDefaults(initial) });
  const rewardType = watch("default_reward_type");
  return <form className="form" onSubmit={handleSubmit(async (value) => { const amount = rewardType === "PERCENT" ? parsePercentToBasisPoints(value.percent) : parseRublesToKopecks(value.fixedRubles); if (amount === null || amount < 0) return; try { await submit(agentCommand(value, amount, immutableSlug)); } catch { /* visible below */ } })}>
    <label>Slug <input {...register("slug", { required: true })} readOnly={immutableSlug} /></label>
    <label>Отображаемое имя <input {...register("display_name", { required: true })} /></label>
    <label>Юридическое имя <input {...register("legal_name", { required: true })} /></label>
    <label>Email <input type="email" {...register("email", { required: true })} /></label>
    <label>ИНН <input inputMode="numeric" {...register("inn", { required: true })} /></label>
    <label>Договор <input {...register("contract_reference", { required: true })} /></label>
    <label>Тип исполнителя <select {...register("contractor_type")}><option value="SELF_EMPLOYED">Самозанятый</option><option value="INDIVIDUAL_ENTREPRENEUR">ИП</option></select></label>
    <label>Тип вознаграждения <select {...register("default_reward_type")}><option value="PERCENT">Процент</option><option value="FIXED">Фиксированное</option></select></label>
    {rewardType === "PERCENT" ? <label>Процент <Controller control={control} name="percent" rules={{ required: true }} render={({ field }) => <PercentInput value={field.value} onChange={field.onChange} minBasisPoints={0} />} /></label> : <label>Вознаграждение, ₽<Controller control={control} name="fixedRubles" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} required />} /></label>}
    <label className="checkbox-field"><input type="checkbox" {...register("enabled")} aria-describedby="agent-enabled-help" /><span><strong>Агент активен</strong><small id="agent-enabled-help">Отключённый агент не получает новые attribution через промокоды и referral links. История заказов сохраняется.</small></span></label>
    <Notice error={error} /><button className="primary" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
  </form>;
}

export function Agents() {
  const agents = useQuery({ queryKey: agentKeys.list(), queryFn: () => api<{ agents: Row[] }>("/agents") });
  const createKey = usePersistentIdempotencyKey(); const editKey = usePersistentIdempotencyKey();
  const [editing, setEditing] = useState<Row | null>(null);
  const create = useAdminMutation("agent.create", ({ body, key }: { body: AgentInput; key: string }) => api("/agents", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const patch = useAdminMutation("agent.patch", ({ id, body, key }: { id: string; body: Omit<AgentInput, "slug">; key: string }) => api(`/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }), { context: (input) => ({ agentId: input.id }) });
  return <><PageTitle eyebrow="COMMERCE / ATTRIBUTION" title={<>Агенты<br /><i>и промо.</i></>} text="Slug — immutable human-readable handle; agents.id is the local identity. All writes are idempotent audited commands." />
    <section className="two-col catalog-grid"><Panel title="Агенты">{agents.isLoadingError ? <Notice error={(agents.error as { code?: string }).code} /> : !agents.data ? <Loading /> : <table><thead><tr><th>Агент</th><th>Статус</th><th>Промо</th><th /></tr></thead><tbody>{agents.data.agents.map((agent) => <tr key={string(agent.id)}><td><strong>{string(agent.display_name)}</strong><small>{string(agent.slug)}</small></td><td>{Number(agent.enabled) ? "Активен" : "Отключён"}</td><td>{number(agent.promo_count)}</td><td><button onClick={() => setEditing(agent)}>Редактировать</button></td></tr>)}</tbody></table>}</Panel>
    <Panel title="Добавить агента"><AgentForm submit={async (body) => { await create.mutateAsync({ body: body as AgentInput, key: createKey.acquire() }); createKey.clear(); }} pending={create.isPending} error={create.error?.code} /></Panel></section>
    {editing ? <Dialog title="Редактировать агента" close={() => setEditing(null)} className="editor"><AgentForm immutableSlug initial={{ slug: string(editing.slug), display_name: string(editing.display_name), legal_name: string(editing.legal_name), email: string(editing.email), contractor_type: string(editing.contractor_type) as AgentInput["contractor_type"], inn: string(editing.inn), contract_reference: string(editing.contract_reference), enabled: Number(editing.enabled) === 1, default_reward_type: string(editing.default_reward_type) as AgentInput["default_reward_type"], default_reward_value: number(editing.default_reward_value) }} submit={async (body) => { await patch.mutateAsync({ id: string(editing.id), body: body as Omit<AgentInput, "slug">, key: editKey.acquire() }); editKey.clear(); setEditing(null); }} pending={patch.isPending} error={patch.error?.code} /></Dialog> : null}</>;
}
