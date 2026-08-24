"use client";

import { useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

export function OccurrenceCompletion({ occurrence, close, done }: { occurrence: Row; close: () => void; done: () => void }) {
  const { register, handleSubmit } = useForm<{ reason: string }>({ defaultValues: { reason: "" } });
  const mutation = useAdminMutation(
    "occurrence.complete",
    ({ reason }: { reason: string }) => api(`/occurrences/${string(occurrence.id)}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation_text: `COMPLETE ${string(occurrence.id)}`, reason }) }),
    { context: () => ({ occurrenceId: string(occurrence.id) }) },
  );

  const submit = handleSubmit(async ({ reason }) => {
    try {
      await mutation.mutateAsync({ reason });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  });

  return (
    <Dialog title="Подтвердить проведение" close={close}>
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">FULFILLMENT / EXPLICIT COMMAND</p>
        <h2>Подтвердить проведение</h2>
        <p>Подтверждает, что мастер-класс фактически состоялся. Операция доступна только после завершения времени события при закрытых продажах.</p>
        <label>Причина<textarea autoFocus {...register("reason", { required: true, minLength: 3 })} /><small>Укажите причину. Она будет сохранена в журнале действий.</small></label>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Подтверждаем…" : "Подтвердить проведение"}</button>
        </div>
      </form>
    </Dialog>
  );
}
