"use client";

import { useForm } from "react-hook-form";
import { api } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { string } from "../../lib/values";
import type { Row } from "../../lib/page";
import { ActionModal } from "../ui/ActionModal";
import { Notice } from "../ui/Notice";

export function ProviderDriftResolution({ review, close, done }: { review: Row; close: () => void; done: () => void }) {
  const { register, handleSubmit } = useForm<{ note: string }>({ defaultValues: { note: "" } });
  const mutation = useAdminMutation("drift.resolve", ({ note }: { note: string }) => api(`/provider-drift-reviews/${string(review.id)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) }));
  return <ActionModal title="Закрыть provider drift review" close={close}><form className="form" onSubmit={handleSubmit(async ({ note }) => { try { await mutation.mutateAsync({ note: note.trim() }); done(); } catch { /* visible below */ } })}>
    <label>Причина<textarea autoFocus required {...register("note", { required: true })} /><small>Это review bookkeeping, а не решение оплаты.</small></label>
    <Notice error={mutation.error?.code} /><button className="primary" disabled={mutation.isPending}>{mutation.isPending ? "Сохраняем…" : "Закрыть review"}</button>
  </form></ActionModal>;
}
