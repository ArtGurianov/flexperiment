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
import { parseRublesToKopecks } from "../../../../lib/money";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";

type AgentInput = { slug: string; display_name: string; legal_name: string; email: string; contractor_type: "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR"; inn: string; contract_reference: string; enabled: boolean; default_reward_type: "PERCENT" | "FIXED"; default_reward_value: number };
const defaults: AgentInput = { slug: "", display_name: "", legal_name: "", email: "", contractor_type: "SELF_EMPLOYED", inn: "", contract_reference: "", enabled: true, default_reward_type: "PERCENT", default_reward_value: 0 };

function AgentForm({ initial = defaults, immutableSlug = false, submit, pending, error }: { initial?: AgentInput; immutableSlug?: boolean; submit: (value: AgentInput) => Promise<void>; pending: boolean; error?: string }) {
  const { register, handleSubmit, watch, control } = useForm<AgentInput & { percent: string; fixedRubles: string }>({ defaultValues: { ...initial, percent: initial.default_reward_type === "PERCENT" ? formatBasisPoints(initial.default_reward_value).replace("%", "") : "", fixedRubles: initial.default_reward_type === "FIXED" ? (initial.default_reward_value / 100).toFixed(2).replace(".", ",") : "" } });
  const rewardType = watch("default_reward_type");
  return <form className="form" onSubmit={handleSubmit(async (value) => { const amount = rewardType === "PERCENT" ? parsePercentToBasisPoints(value.percent) : parseRublesToKopecks(value.fixedRubles); if (amount === null) return; try { await submit({ ...value, default_reward_value: amount }); } catch { /* visible below */ } })}>
    <label>Slug <input {...register("slug", { required: true })} readOnly={immutableSlug} /></label>
    <label>Отображаемое имя <input {...register("display_name", { required: true })} /></label>
    <label>Юридическое имя <input {...register("legal_name", { required: true })} /></label>
    <label>Email <input type="email" {...register("email", { required: true })} /></label>
    <label>ИНН <input inputMode="numeric" {...register("inn", { required: true })} /></label>
    <label>Договор <input {...register("contract_reference", { required: true })} /></label>
    <label>Тип исполнителя <select {...register("contractor_type")}><option value="SELF_EMPLOYED">Самозанятый</option><option value="INDIVIDUAL_ENTREPRENEUR">ИП</option></select></label>
    <label>Тип вознаграждения <select {...register("default_reward_type")}><option value="PERCENT">Процент</option><option value="FIXED">Фиксированное</option></select></label>
    {rewardType === "PERCENT" ? <label>Процент <input inputMode="decimal" {...register("percent", { required: true })} /><small>Например, 10%.</small></label> : <label>Вознаграждение, ₽<Controller control={control} name="fixedRubles" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} required />} /></label>}
    <label><input type="checkbox" {...register("enabled")} /> Активен</label>
    <Notice error={error} /><button className="primary" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
  </form>;
}

export function Agents() {
  const agents = useQuery({ queryKey: agentKeys.list(), queryFn: () => api<{ agents: Row[] }>("/agents") });
  const createKey = usePersistentIdempotencyKey(); const editKey = usePersistentIdempotencyKey();
  const [editing, setEditing] = useState<Row | null>(null);
  const create = useAdminMutation("agent.create", ({ body, key }: { body: AgentInput; key: string }) => api("/agents", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const patch = useAdminMutation("agent.patch", ({ id, body, key }: { id: string; body: AgentInput; key: string }) => api(`/agents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([field]) => field !== "slug"))) }), { context: (input) => ({ agentId: input.id }) });
  return <><PageTitle eyebrow="COMMERCE / ATTRIBUTION" title={<>Агенты<br /><i>и промо.</i></>} text="Slug — immutable human-readable handle; agents.id is the local identity. All writes are idempotent audited commands." />
    <section className="two-col catalog-grid"><Panel title="Агенты">{agents.isLoadingError ? <Notice error={(agents.error as { code?: string }).code} /> : !agents.data ? <Loading /> : <table><thead><tr><th>Агент</th><th>Статус</th><th>Промо</th><th /></tr></thead><tbody>{agents.data.agents.map((agent) => <tr key={string(agent.id)}><td><strong>{string(agent.display_name)}</strong><small>{string(agent.slug)}</small></td><td>{Number(agent.enabled) ? "Активен" : "Отключён"}</td><td>{number(agent.promo_count)}</td><td><button onClick={() => setEditing(agent)}>Редактировать</button></td></tr>)}</tbody></table>}</Panel>
    <Panel title="Добавить агента"><AgentForm submit={async (body) => { await create.mutateAsync({ body, key: createKey.acquire() }); createKey.clear(); }} pending={create.isPending} error={create.error?.code} /></Panel></section>
    {editing ? <Dialog title="Редактировать агента" close={() => setEditing(null)} className="editor"><AgentForm immutableSlug initial={{ ...defaults, ...editing, enabled: Number(editing.enabled) === 1, default_reward_value: number(editing.default_reward_value), contractor_type: string(editing.contractor_type) as AgentInput["contractor_type"], default_reward_type: string(editing.default_reward_type) as AgentInput["default_reward_type"] }} submit={async (body) => { await patch.mutateAsync({ id: string(editing.id), body, key: editKey.acquire() }); editKey.clear(); setEditing(null); }} pending={patch.isPending} error={patch.error?.code} /></Dialog> : null}</>;
}
