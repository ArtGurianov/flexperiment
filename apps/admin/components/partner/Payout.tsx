"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import type { Row } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";

/** PAYOUT_PROFILE_SUPERSESSION step-up resource is { supersedes_revision_id: <current row id or null> } - must match setPartnerPayoutDestination/revokePartnerPayoutDestination's own re-derivation exactly. */
export function Payout() {
  const queryClient = useQueryClient();
  const payout = useQuery({ queryKey: ["partner", "payout-profile"], queryFn: () => partnerApi<Row | null>("/payout-profile") });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit } = useForm<{ destination_kind: string; destination_plaintext: string; destination_last4: string }>({
    defaultValues: { destination_kind: "BANK_CARD", destination_plaintext: "", destination_last4: "" },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["partner", "payout-profile"] });

  const setDestination = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      const current = payout.data as Row | null;
      const resource = { supersedes_revision_id: current?.id ?? null };
      const { grant_id } = await partnerApi<{ grant_id: string }>("/step-up", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "PAYOUT_PROFILE_SUPERSESSION", resource }),
      });
      await partnerApi("/payout-profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step_up_grant_id: grant_id, ...values }),
      });
      refresh();
    } catch (failure) {
      setError((failure as PartnerApiError).code);
    } finally {
      setBusy(false);
    }
  });

  const revoke = async () => {
    setBusy(true); setError(null);
    try {
      const current = payout.data as Row | null;
      const resource = { supersedes_revision_id: current?.id ?? null };
      const { grant_id } = await partnerApi<{ grant_id: string }>("/step-up", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "PAYOUT_PROFILE_SUPERSESSION", resource }),
      });
      await partnerApi("/payout-profile/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step_up_grant_id: grant_id }) });
      refresh();
    } catch (failure) {
      setError((failure as PartnerApiError).code);
    } finally {
      setBusy(false);
    }
  };

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
