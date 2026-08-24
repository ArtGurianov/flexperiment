"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { formatRubles, parseRublesToKopecks } from "../../../../lib/money";
import { ActionModal } from "../ui/ActionModal";
import { MoneyInput } from "../ui/MoneyInput";
import { Notice } from "../ui/Notice";

export function RefundAction({ orderId, max, close }: { orderId: string; max: number; close: () => void }) {
  const { control, register, handleSubmit, watch } = useForm<{ amount: string; reason: string; note: string }>({ defaultValues: { amount: String(max / 100), reason: "", note: "" } });
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "order.refund",
    (body: { amount_kopecks: number; reason: string; note?: string }) =>
      api(`/orders/${orderId}/refunds`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ orderId }) },
  );

  const submit = handleSubmit(async ({ amount, reason, note }) => {
    const amountKopecks = parseRublesToKopecks(amount);
    if (amountKopecks === null || amountKopecks <= 0 || amountKopecks > max) return;
    try {
      await mutation.mutateAsync({ amount_kopecks: amountKopecks, reason, note: note || undefined });
      close();
    } catch {
      // error surfaced via mutation.error below
    }
  });
  const amount = watch("amount");
  const amountKopecks = parseRublesToKopecks(amount);
  const amountValid = amountKopecks !== null && amountKopecks > 0 && amountKopecks <= max;

  return (
    <ActionModal title="Компенсационный возврат" close={close}>
      <form className="form" onSubmit={submit}>
        <label>Сумма, ₽<Controller control={control} name="amount" rules={{ required: true }} render={({ field }) => <MoneyInput value={field.value} onChange={field.onChange} maxKopecks={max} required />} /></label>
        <p>Доступно к возврату: <strong>{formatRubles(max)}</strong>.</p>
        <label>Причина<textarea {...register("reason", { required: true, minLength: 3 })} /><small>Укажите причину. Она будет сохранена в журнале действий.</small></label>
        <label>Комментарий<textarea {...register("note")} /></label>
        <Notice error={mutation.error?.code} />
        <button className="primary" disabled={mutation.isPending || !amountValid}>{mutation.isPending ? "Создаём…" : `Создать refund ${amountKopecks === null ? "" : formatRubles(amountKopecks)}`}</button>
      </form>
    </ActionModal>
  );
}
