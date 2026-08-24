"use client";

import { FormEvent, useState } from "react";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";

export function EmailAttentionAcknowledgement({ incident, close, done }: { incident: Row; close: () => void; done: () => void }) {
  const [reason, setReason] = useState("");
  const mutation = useAdminMutation("email.acknowledge", (body: { audit_context?: string }) =>
    api(`/email-attention/${string(incident.id)}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ audit_context: reason.trim() || undefined });
      done();
    } catch {
      // error surfaced via mutation.error below
    }
  };

  return (
    <ActionModal title="Отметить email-инцидент рассмотренным" close={close}>
      <form className="form" onSubmit={submit}>
        <p>Это не меняет delivery state, не вызывает provider и не создаёт resend.</p>
        <label>Причина<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} /><small>Необязательно. Будет сохранено в журнале действий.</small></label>
        <Notice error={mutation.error?.code} />
        <button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Отметить рассмотренным"}</button>
      </form>
    </ActionModal>
  );
}
