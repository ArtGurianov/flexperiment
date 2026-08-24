"use client";

import { FormEvent, useState } from "react";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { formatRubles, parseRublesToKopecks } from "../../../../lib/money";
import { ActionModal } from "../ui/ActionModal";
import { MoneyInput } from "../ui/MoneyInput";
import { Notice } from "../ui/Notice";

export function RefundAction({ orderId, max, close }: { orderId: string; max: number; close: () => void }) {
  const [amount, setAmount] = useState(() => String(max / 100));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "order.refund",
    (body: { amount_kopecks: number; reason: string; note?: string }) =>
      api(`/orders/${orderId}/refunds`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ orderId }) },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountKopecks = parseRublesToKopecks(amount);
    if (amountKopecks === null || amountKopecks <= 0 || amountKopecks > max) return;
    try {
      await mutation.mutateAsync({ amount_kopecks: amountKopecks, reason, note: note || undefined });
      close();
    } catch {
      // error surfaced via mutation.error below
    }
  };
  const amountKopecks = parseRublesToKopecks(amount);
  const amountValid = amountKopecks !== null && amountKopecks > 0 && amountKopecks <= max;

  return (
    <ActionModal title="Компенсационный возврат" close={close}>
      <form className="form" onSubmit={submit}>
        <label>Сумма, ₽<MoneyInput value={amount} onChange={setAmount} maxKopecks={max} required /></label>
        <p>Доступно к возврату: <strong>{formatRubles(max)}</strong>.</p>
        <label>Причина<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} required /></label>
        <label>Комментарий<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <Notice error={mutation.error?.code} />
        <button className="primary" disabled={mutation.isPending || !amountValid}>{mutation.isPending ? "Создаём…" : `Создать refund ${amountKopecks === null ? "" : formatRubles(amountKopecks)}`}</button>
      </form>
    </ActionModal>
  );
}
