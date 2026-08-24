"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

export function OccurrenceCancellation({ occurrence, close, done }: { occurrence: Row; close: () => void; done: () => void }) {
  const { register, handleSubmit, resetField } = useForm<{ reason: string; password: string }>({ defaultValues: { reason: "", password: "" } });
  const [key] = useState(idempotencyKey);

  const mutation = useAdminMutation(
    "occurrence.cancel",
    async ({ reason, password }: { reason: string; password: string }) => {
      const reauth = await api<{ capability: string }>("/reauth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, purpose: "CANCEL_OCCURRENCE", resource_id: string(occurrence.id) }) });
      resetField("password");
      return api(`/occurrences/${string(occurrence.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ reason, reauth_capability: reauth.capability }) });
    },
    { context: () => ({ occurrenceId: string(occurrence.id) }) },
  );

  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  });

  return (
    <Dialog title="Отменить событие" close={close}>
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">TERMINAL / REAUTH REQUIRED</p>
        <h2>Отменить событие</h2>
        <p>{string(occurrence.title)}</p>
        <p>Продажи будут закрыты, активные бронирования отменены, билеты аннулированы, а полный возврат будет создан через штатный worker.</p>
        <label>Причина<textarea autoFocus {...register("reason", { required: true, minLength: 3 })} /><small>Укажите причину. Она будет сохранена в журнале действий.</small></label>
        <label>Текущий пароль администратора<input type="password" autoComplete="current-password" {...register("password", { required: true })} /></label>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button className="danger" disabled={mutation.isPending}>{mutation.isPending ? "Отменяем…" : "Подтвердить отмену"}</button>
        </div>
      </form>
    </Dialog>
  );
}
