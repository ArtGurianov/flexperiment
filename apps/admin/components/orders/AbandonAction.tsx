"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";

export function AbandonAction({ orderId, close }: { orderId: string; close: () => void }) {
  const { register, handleSubmit } = useForm<{ reason: string }>({ defaultValues: { reason: "" } });
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "order.abandonReservation",
    (body: { reason: string }) =>
      api(`/orders/${orderId}/abandon-reservation`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ orderId }) },
  );

  const submit = handleSubmit(async ({ reason }) => {
    try {
      await mutation.mutateAsync({ reason });
      close();
    } catch {
      // error surfaced via mutation.error below
    }
  });

  return (
    <ActionModal title="Technical reservation abandonment" close={close}>
      <p>Команда доступна только потому, что backend сейчас явно считает эту reservation abandonable. Поздняя успешная оплата не восстановит booking.</p>
      <form className="form" onSubmit={submit}>
        <label>Причина<textarea {...register("reason", { required: true, minLength: 3 })} /><small>Укажите причину. Она будет сохранена в журнале действий.</small></label>
        <Notice error={mutation.error?.code} />
        <button className="danger" disabled={mutation.isPending}>{mutation.isPending ? "Выполняем…" : "Подтвердить abandonment"}</button>
      </form>
    </ActionModal>
  );
}
