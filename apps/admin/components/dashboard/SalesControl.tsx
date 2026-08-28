"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";

type SalesControl = { effective_status: "OPEN" | "PAUSED"; emergency: { sales_paused: boolean; revision: number; paused_at: string | null; paused_reason: string | null }; release_paused: boolean };
type FormValues = { reason: string };
type PendingAction = { mode: "pause" | "reopen"; expectedRevision: number; reason?: string };

export function SalesControl({ control }: { control: SalesControl }) {
  const [action, setAction] = useState<PendingAction | null>(null);
  const key = usePersistentIdempotencyKey();
  const form = useForm<FormValues>({ defaultValues: { reason: "" } });
  const mutation = useAdminMutation(
    action?.mode === "pause" ? "emergency-sales-pause" : "emergency-sales-reopen",
    ({ mode, body, idempotencyKey }: { mode: "pause" | "reopen"; body: { expected_revision: number; reason: string }; idempotencyKey: string }) => api(`/emergency-sales/${mode}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) }),
    {},
  );
  const open = (mode: PendingAction["mode"]) => { key.clear(); form.reset(); setAction({ mode, expectedRevision: control.emergency.revision }); };
  const close = () => { if (!mutation.isPending) { key.clear(); setAction(null); form.reset(); } };
  const submit = form.handleSubmit(async ({ reason }) => {
    if (!action) return;
    const command = action.reason === undefined ? { ...action, reason } : action;
    if (action.reason === undefined) setAction(command);
    try { await mutation.mutateAsync({ mode: command.mode, body: { expected_revision: command.expectedRevision, reason: command.reason }, idempotencyKey: key.acquire() }); key.clear(); close(); }
    catch { /* error is rendered in the modal */ }
  });
  return <>
    <Panel title="Экстренная остановка продаж">
      <p>{control.effective_status === "PAUSED" ? "Продажи сейчас остановлены." : "Продажи открыты."}</p>
      {control.emergency.sales_paused ? <p className="notice notice-error">Экстренная остановка включена{control.emergency.paused_at ? `: ${control.emergency.paused_at}` : ""}. Причина: {control.emergency.paused_reason ?? "не указана"}.</p> : <p className="notice">Экстренная остановка не включена.</p>}
      {control.release_paused ? <p className="notice notice-error">Пауза release-control также включена. Снятие экстренной остановки не откроет продажи, пока release-control не завершён.</p> : null}
      <div className="detail-actions"><button className={control.emergency.sales_paused ? "primary" : "danger"} onClick={() => open(control.emergency.sales_paused ? "reopen" : "pause")}>{control.emergency.sales_paused ? "Снять экстренную остановку" : "Остановить продажи"}</button></div>
    </Panel>
    {action ? <ActionModal title={action.mode === "pause" ? "Экстренно остановить продажи" : "Снять экстренную остановку"} close={close}>
      <p>{action.mode === "pause" ? "Остановка абсолютна: она блокирует и сертификационные заказы. Укажите причину для журнала." : "Будет снята только экстренная остановка. Пауза развёртывания, если она есть, сохранится."}</p>
      <form className="form" onSubmit={submit}><label>Причина<textarea {...form.register("reason", { required: true, minLength: 3, maxLength: 1000 })} readOnly={action.reason !== undefined} /><small>Обязательное поле, сохраняется в журнале действий.</small></label><Notice error={mutation.error?.code} />{mutation.error?.code === "SALES_GATE_REVISION_CONFLICT" ? <p role="status">Состояние перечитано. Закройте это подтверждение и откройте новое с актуальной ревизией.</p> : null}<button className={action.mode === "pause" ? "danger" : "primary"} disabled={mutation.isPending || mutation.error?.code === "SALES_GATE_REVISION_CONFLICT"}>{mutation.isPending ? "Выполняем…" : "Подтвердить"}</button></form>
    </ActionModal> : null}
  </>;
}
