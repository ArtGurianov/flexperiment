"use client";

import { FormEvent, useState } from "react";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";

export function AbandonAction({ orderId, close }: { orderId: string; close: () => void }) {
  const [reason, setReason] = useState("");
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "order.abandonReservation",
    (body: { reason: string }) =>
      api(`/orders/${orderId}/abandon-reservation`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ orderId }) },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ reason });
      close();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  return (
    <ActionModal title="Technical reservation abandonment" close={close}>
      <p>Команда доступна только потому, что backend сейчас явно считает эту reservation abandonable. Поздняя успешная оплата не восстановит booking.</p>
      <form className="form" onSubmit={submit}>
        <label>Причина<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} required /></label>
        <Notice error={mutation.error?.code} />
        <button className="danger" disabled={mutation.isPending}>{mutation.isPending ? "Выполняем…" : "Подтвердить abandonment"}</button>
      </form>
    </ActionModal>
  );
}
