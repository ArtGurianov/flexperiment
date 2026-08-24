"use client";

import type { FormEvent } from "react";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Notice } from "../ui/Notice";

export function OccurrenceCompletion({ occurrence, close, done }: { occurrence: Row; close: () => void; done: () => void }) {
  const mutation = useAdminMutation(
    "occurrence.complete",
    () => api(`/occurrences/${string(occurrence.id)}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation_text: `COMPLETE ${string(occurrence.id)}` }) }),
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
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <p className="eyebrow">FULFILLMENT / EXPLICIT COMMAND</p>
        <h2>Подтвердить проведение</h2>
        <p>Подтверждает, что мастер-класс фактически состоялся. Операция доступна только после завершения времени события при закрытых продажах.</p>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button type="button" onClick={close}>Отмена</button>
          <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Подтверждаем…" : "Подтвердить проведение"}</button>
        </div>
      </form>
    </div>
  );
}
