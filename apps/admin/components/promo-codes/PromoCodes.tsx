"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { agentKeys, promoKeys } from "../../lib/query-keys";
import { formatBasisPoints, parsePercentToBasisPoints } from "../../lib/percent";
import { number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { PageTitle } from "../ui/PageTitle";
import { MoneyInput } from "../ui/MoneyInput";
import { PercentInput } from "../ui/PercentInput";
import { parseRublesToKopecks } from "../../../../lib/money";

type PromoInput = { code: string; agent_id: string | null; status: "ACTIVE" | "DISABLED"; discount_type: "NONE" | "PERCENT" | "FIXED"; discount_value: number };
const defaults: PromoInput = { code: "", agent_id: null, status: "ACTIVE", discount_type: "PERCENT", discount_value: 100 };
function PromoForm({ initial = defaults, immutableCode = false, agents, submit, pending, error }: { initial?: PromoInput; immutableCode?: boolean; agents: Row[]; submit: (value: PromoInput) => Promise<void>; pending: boolean; error?: string }) {
  const { register, handleSubmit, watch, control } = useForm<PromoInput & { percent: string; fixedRubles: string }>({ defaultValues: { ...initial, percent: initial.discount_type === "PERCENT" ? formatBasisPoints(initial.discount_value).replace("%", "") : "", fixedRubles: initial.discount_type === "FIXED" ? (initial.discount_value / 100).toFixed(2).replace(".", ",") : "" } });
  const type = watch("discount_type");
  return <form className="form" onSubmit={handleSubmit(async (value) => { const amount = type === "NONE" ? 0 : type === "PERCENT" ? parsePercentToBasisPoints(value.percent) : parseRublesToKopecks(value.fixedRubles); if (amount === null || (type === "PERCENT" && (amount < 1 || amount > 9_999))) return; try { await submit({ code: value.code, agent_id: value.agent_id || null, status: value.status, discount_type: value.discount_type, discount_value: amount }); } catch { /* visible below */ } })}>
    <label>Код <input {...register("code", { required: true })} readOnly={immutableCode} /></label>
    <label>Агент <select {...register("agent_id")}><option value="">Без агента</option>{agents.map((agent) => <option key={string(agent.id)} value={string(agent.id)}>{string(agent.display_name)} ({string(agent.slug)})</option>)}</select></label>
    <label>Статус <select {...register("status")}><option value="ACTIVE">Активен</option><option value="DISABLED">Отключён</option></select></label>
    <label>Тип скидки <select {...register("discount_type")}><option value="NONE">Без скидки</option><option value="PERCENT">Процент</option><option value="FIXED">Фиксированная</option></select></label>
    {type === "PERCENT" ? <label>Процент <Controller control={control} name="percent" rules={{ required: true }} render={({ field }) => <PercentInput value={field.value} onChange={field.onChange} minBasisPoints={1} maxBasisPoints={9_999} />} /></label> : type === "FIXED" ? <label>Скидка, ₽<Controller control={control} name="fixedRubles" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} required />} /></label> : null}
    <Notice error={error} /><button className="primary" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</button>
  </form>;
}
export function PromoCodes() {
  const promos = useQuery({ queryKey: promoKeys.list(), queryFn: () => api<{ promo_codes: Row[] }>("/promo-codes") });
  const agents = useQuery({ queryKey: agentKeys.list(), queryFn: () => api<{ agents: Row[] }>("/agents") });
  const [editing, setEditing] = useState<Row | null>(null); const createKey = usePersistentIdempotencyKey(); const editKey = usePersistentIdempotencyKey();
  const create = useAdminMutation("promo.create", ({ body, key }: { body: PromoInput; key: string }) => api("/promo-codes", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  const patch = useAdminMutation("promo.patch", ({ id, body, key }: { id: string; body: PromoInput; key: string }) => api(`/promo-codes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([field]) => field !== "code"))) }), { context: (input) => ({ promoId: input.id }) });
  const agentRows = agents.data?.agents ?? [];
  return <><PageTitle eyebrow="COMMERCE / DISCOUNTS" title={<>Промо<br /><i>коды.</i></>} text="One global code per checkout. Its price evidence is frozen on every new order." />
    <section className="two-col catalog-grid"><Panel title="Промокоды">{promos.isLoadingError ? <Notice error={(promos.error as { code?: string }).code} /> : !promos.data ? <Loading /> : <table><thead><tr><th>Код</th><th>Скидка</th><th>Агент</th><th /></tr></thead><tbody>{promos.data.promo_codes.map((promo) => <tr key={string(promo.id)}><td><strong>{string(promo.code)}</strong><small>{string(promo.status)}</small><small>UUID: <code>{string(promo.id)}</code></small></td><td>{string(promo.discount_type) === "NONE" ? "Без скидки" : string(promo.discount_type) === "PERCENT" ? formatBasisPoints(number(promo.discount_value)) : `${(number(promo.discount_value) / 100).toFixed(2)} ₽`}</td><td>{promo.agent && typeof promo.agent === "object" ? string((promo.agent as Row).display_name) : "—"}</td><td><button onClick={() => setEditing(promo)}>Редактировать</button></td></tr>)}</tbody></table>}</Panel>
    <Panel title="Добавить промокод"><PromoForm agents={agentRows} submit={async (body) => { await create.mutateAsync({ body, key: createKey.acquire() }); createKey.clear(); }} pending={create.isPending} error={create.error?.code} /></Panel></section>
    {editing ? <Dialog title="Редактировать промокод" close={() => setEditing(null)} className="editor"><PromoForm immutableCode agents={agentRows} initial={{ ...defaults, ...editing, agent_id: editing.agent_id ? string(editing.agent_id) : null, status: string(editing.status) as PromoInput["status"], discount_type: string(editing.discount_type) as PromoInput["discount_type"], discount_value: number(editing.discount_value) }} submit={async (body) => { await patch.mutateAsync({ id: string(editing.id), body, key: editKey.acquire() }); editKey.clear(); setEditing(null); }} pending={patch.isPending} error={patch.error?.code} /></Dialog> : null}</>;
}
