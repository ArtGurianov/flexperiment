"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, idempotencyKey } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { occurrenceActionConsequence, type OccurrenceAction as OccurrenceActionSpec } from "../../lib/occurrence-actions";
import { number, string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";

export function OccurrenceAction({ action, close, done }: { action: { occurrence: Row; label: string; patch: OccurrenceActionSpec["patch"] }; close: () => void; done: () => void }) {
  const [key] = useState(idempotencyKey);
  const { handleSubmit } = useForm();

  const mutation = useAdminMutation(
    "occurrence.patch",
    (body: Row) => api(`/occurrences/${string(action.occurrence.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }),
    { context: () => ({ occurrenceId: string(action.occurrence.id) }) },
  );

  const submit = handleSubmit(async () => {
    try {
      await mutation.mutateAsync({ ...action.patch, expected_revision: number(action.occurrence.admin_revision) });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  });

  return (
    <Dialog title={action.label} close={close}>
      <form className="form" onSubmit={submit}>
        <p className="eyebrow">EXPLICIT CATALOG ACTION</p>
        <h2>{action.label}</h2>
        <p>{string(action.occurrence.title)}</p>
        <p>{occurrenceActionConsequence(action.patch)}</p>
        <Notice error={mutation.error?.code} />
        <div className="modal-actions">
          <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Подтвердить"}</button>
        </div>
      </form>
    </Dialog>
  );
}
