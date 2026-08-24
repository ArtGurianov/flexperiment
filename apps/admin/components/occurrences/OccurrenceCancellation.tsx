"use client";

import { FormEvent, useState } from "react";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

export function OccurrenceCancellation({ occurrence, close, done }: { occurrence: Row; close: () => void; done: () => void }) {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "occurrence.cancel",
    async () => {
      const reauth = await api<{ capability: string }>("/reauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, purpose: "CANCEL_OCCURRENCE", resource_id: string(occurrence.id) }) });
      setPassword("");
      return api(`/occurrences/${string(occurrence.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ reason, reauth_capability: reauth.capability }) });
    },
    { context: () => ({ occurrenceId: string(occurrence.id) }) },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync(undefined);
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  return (
    <Dialog title="Отменить событие" close={close}>
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">TERMINAL / REAUTH REQUIRED</p>
        <h2>Отменить событие</h2>
        <p>{string(occurrence.title)}</p>
        <p>Продажи будут закрыты, активные бронирования отменены, билеты аннулированы, а полный возврат будет создан через штатный worker.</p>
        <label>Причина<textarea autoFocus required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <label>Текущий пароль администратора<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button className="danger" disabled={mutation.isPending}>{mutation.isPending ? "Отменяем…" : "Подтвердить отмену"}</button>
        </div>
      </form>
    </Dialog>
  );
}
