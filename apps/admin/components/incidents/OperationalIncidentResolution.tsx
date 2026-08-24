"use client";

import { FormEvent, useState } from "react";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";

export function OperationalIncidentResolution({ incident, close, done }: { incident: Row; close: () => void; done: () => void }) {
  const [reason, setReason] = useState("");
  const mutation = useAdminMutation("incident.resolve", (body: { reason: string }) =>
    api(`/operational-incidents/${string(incident.id)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ reason });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  return (
    <ActionModal title="Закрыть операционный инцидент" close={close}>
      <form className="form" onSubmit={submit}>
        <label>Результат рассмотрения<textarea autoFocus required minLength={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <Notice error={mutation.error?.code} />
        <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Отметить решённым"}</button>
      </form>
    </ActionModal>
  );
}
