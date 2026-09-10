"use client";

import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import { usePartnerMutation } from "../../lib/use-partner-mutation";
import { partnerKeys } from "../../lib/query-keys";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import type { Row } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";

/** PAYOUT_PROFILE_SUPERSESSION step-up resource is { supersedes_revision_id: <current row id or null> } - must match setPartnerPayoutDestination/revokePartnerPayoutDestination's own re-derivation exactly. */
/**
 * The grant mint and the command it authorizes are ONE intent, so they live
 * inside one mutationFn: a grant is single-use and bound to
 * supersedes_revision_id, so a half-completed pair must never be left for a
 * caller to "finish" with a second, differently-bound grant.
 */
const mintPayoutStepUp = async (currentRevisionId: string | null) => {
  const { grant_id } = await partnerApi<{ grant_id: string }>("/step-up", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "PAYOUT_PROFILE_SUPERSESSION", resource: { supersedes_revision_id: currentRevisionId } }),
  });
  return grant_id;
};

export function Payout() {
  const payout = useQuery({ queryKey: partnerKeys.payoutProfile(), queryFn: () => partnerApi<Row | null>("/payout-profile") });
  const { register, handleSubmit } = useForm<{ destination_kind: string; destination_plaintext: string; destination_last4: string }>({
    defaultValues: { destination_kind: "BANK_CARD", destination_plaintext: "", destination_last4: "" },
  });
  const currentRevisionId = (payout.data as Row | null)?.id;

  // PR-C2: the step-up grant does NOT make these retry-safe - a retry mints
  // a fresh grant, and after the authoritative refresh that grant is
  // legitimately bound to the revision the first attempt created. The
  // command key is what stops a second revision; it is retained across a
  // failure and rotated only after a genuine success.
  const setKey = usePersistentIdempotencyKey();
  const revokeKey = usePersistentIdempotencyKey();
  const set = usePartnerMutation("partner.payoutSet", async (values: Record<string, unknown>) => {
    const grantId = await mintPayoutStepUp(currentRevisionId ? String(currentRevisionId) : null);
    return partnerApi("/payout-profile", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": setKey.acquire() },
      body: JSON.stringify({ step_up_grant_id: grantId, ...values }),
    });
  });
  const revokeDestination = usePartnerMutation("partner.payoutRevoke", async () => {
    const grantId = await mintPayoutStepUp(currentRevisionId ? String(currentRevisionId) : null);
    return partnerApi("/payout-profile/revoke", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": revokeKey.acquire() }, body: JSON.stringify({ step_up_grant_id: grantId }),
    });
  });
  const busy = set.isPending || revokeDestination.isPending;
  const error = set.error?.code ?? revokeDestination.error?.code ?? null;

  const setDestination = handleSubmit(async (values) => { await set.mutateAsync(values).then(() => setKey.clear()).catch(() => undefined); });
  const revoke = async () => { await revokeDestination.mutateAsync(undefined).then(() => revokeKey.clear()).catch(() => undefined); };

  if (payout.isLoading) return <Loading />;
  if (payout.isError) return <Notice error={(payout.error as PartnerApiError).code} />;
  const current = payout.data;

  return (
    <>
      <PageTitle eyebrow="ВЫПЛАТЫ" title="Реквизиты для выплат" text="Данные шифруются немедленно; открытый номер карты/счёта здесь не хранится и не отображается повторно." />
      <section className="card">
        {current && current.kind === "ACTIVE_DESTINATION" ? (
          <>
            <p>Текущие реквизиты: {String(current.destination_kind)} •••• {String(current.destination_last4)}</p>
            <button disabled={busy} onClick={() => void revoke()}>{busy ? "Отзываем…" : "Отозвать реквизиты"}</button>
          </>
        ) : (
          <p>Реквизиты не установлены.</p>
        )}
      </section>
      <section className="card">
        <h2>{current ? "Заменить реквизиты" : "Установить реквизиты"}</h2>
        <form onSubmit={setDestination}>
          <label>
            Тип
            <select {...register("destination_kind")}>
              <option value="BANK_CARD">Банковская карта</option>
              <option value="BANK_ACCOUNT">Банковский счёт</option>
            </select>
          </label>
          <label>
            Полный номер
            <input autoComplete="off" {...register("destination_plaintext", { required: true })} />
          </label>
          <label>
            Последние 4 цифры (для отображения)
            <input maxLength={4} {...register("destination_last4", { required: true })} />
          </label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>
        </form>
      </section>
    </>
  );
}
