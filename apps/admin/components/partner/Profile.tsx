"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import type { Row } from "../../lib/partner-page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { PageTitle } from "../ui/PageTitle";
import { Badge } from "../ui/Badge";

const ONBOARDING_LABELS: Record<string, string> = {
  INVITED: "Приглашён", PROFILE_SUBMITTED: "Профиль отправлен", PROFILE_VERIFIED: "Профиль проверен",
  FRAMEWORK_ISSUED: "Договор выдан", FRAMEWORK_ACCEPTED: "Договор принят", PARTNER_ACTIVE: "Активен",
};

const CHANGE_REQUEST_STATE_LABELS: Record<string, string> = {
  PENDING: "На рассмотрении", VERIFIED: "Подтверждена", REJECTED: "Отклонена", STALE: "Устарела",
};

/** PR-E: the unified requisites tuple - present on every legal-profile submission (initial onboarding and D2 supersession alike). */
type LegalRequisitesFormFields = { opf: string; full_name: string; short_name: string; inn: string; kpp: string; registration_number: string; legal_address: string };

/** Mirrors the backend's frozen legal_form x tax_mode matrix (commerce/src/agent-referrals-legal-profile.ts's PROJECTION table) - only INDIVIDUAL_ENTREPRENEUR actually has a choice. */
const TAX_MODE_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  INDIVIDUAL: [{ value: "NPD", label: "НПД (самозанятый)" }],
  INDIVIDUAL_ENTREPRENEUR: [{ value: "NPD", label: "НПД (самозанятый)" }, { value: "OTHER", label: "Другой" }],
  LEGAL_ENTITY: [{ value: "OTHER", label: "Другой" }],
};

/** Keeps tax_mode inside the set the selected legal_form actually allows - without this, switching legal_form silently leaves a now-invalid tax_mode selected and the submission fails REJECTED_COMBINATION for no reason visible in the form itself. */
function useConstrainedTaxMode(legalForm: string, taxMode: string, setValue: (name: "tax_mode", value: string) => void) {
  useEffect(() => {
    const allowed = TAX_MODE_OPTIONS[legalForm]?.map((o) => o.value) ?? [];
    if (allowed.length && !allowed.includes(taxMode)) setValue("tax_mode", allowed[0]);
  }, [legalForm, taxMode, setValue]);
}

/**
 * Renders only the fields the selected legal_form actually requires -
 * matches normalizeAndValidateLegalProfile's own per-legal_form shape
 * matrix exactly (commerce/src/agent-referrals-legal-profile.ts), so a
 * partner is never shown a field the backend would refuse (or asked for
 * one it silently ignores).
 */
function LegalRequisitesFields({ legalForm, register }: { legalForm: string; register: UseFormRegister<LegalRequisitesFormFields> }) {
  return (
    <>
      <label>ФИО / полное наименование <input {...register("full_name", { required: true })} /></label>
      {legalForm === "LEGAL_ENTITY" && <label>Сокращённое наименование <input {...register("short_name")} /></label>}
      {legalForm === "LEGAL_ENTITY" && <label>ОПФ <input {...register("opf", { required: true })} placeholder="ООО" /></label>}
      <label>ИНН <input {...register("inn", { required: true })} placeholder={legalForm === "LEGAL_ENTITY" ? "10 цифр" : "12 цифр"} /></label>
      {legalForm === "LEGAL_ENTITY" && <label>КПП <input {...register("kpp", { required: true })} placeholder="9 цифр" /></label>}
      {(legalForm === "INDIVIDUAL_ENTREPRENEUR" || legalForm === "LEGAL_ENTITY") && (
        <label>{legalForm === "INDIVIDUAL_ENTREPRENEUR" ? "ОГРНИП" : "ОГРН"} <input {...register("registration_number", { required: true })} placeholder={legalForm === "INDIVIDUAL_ENTREPRENEUR" ? "15 цифр" : "13 цифр"} /></label>
      )}
      {legalForm === "LEGAL_ENTITY" && <label>Юридический адрес <input {...register("legal_address", { required: true })} /></label>}
    </>
  );
}

export function Profile() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ["partner", "me"], queryFn: () => partnerApi<Row>("/me") });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // shouldUnregister: a field hidden by LegalRequisitesFields' own
  // conditional rendering (e.g. opf/kpp/legal_address when legal_form
  // switches away from LEGAL_ENTITY) must not survive in form state - RHF's
  // default keeps it, which would resubmit a stale value the backend
  // correctly refuses as AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_FORBIDDEN.
  const { register, handleSubmit, watch, setValue } = useForm<{ legal_form: string; tax_mode: string } & LegalRequisitesFormFields>({
    shouldUnregister: true,
    defaultValues: { legal_form: "INDIVIDUAL", tax_mode: "NPD", opf: "", full_name: "", short_name: "", inn: "", kpp: "", registration_number: "", legal_address: "" },
  });
  const changeForm = useForm<{ legal_form: string; tax_mode: string; reason: string } & LegalRequisitesFormFields>({
    shouldUnregister: true,
    defaultValues: { legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "", opf: "", full_name: "", short_name: "", inn: "", kpp: "", registration_number: "", legal_address: "" },
  });
  const submitLegalForm = watch("legal_form");
  const submitTaxMode = watch("tax_mode");
  const changeLegalForm = changeForm.watch("legal_form");
  const changeTaxMode = changeForm.watch("tax_mode");
  useConstrainedTaxMode(submitLegalForm, submitTaxMode, setValue);
  useConstrainedTaxMode(changeLegalForm, changeTaxMode, changeForm.setValue);

  const submitLegalProfile = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await partnerApi("/legal-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      await queryClient.invalidateQueries({ queryKey: ["partner", "me"] });
    } catch (failure) {
      setError((failure as PartnerApiError).code);
    } finally {
      setBusy(false);
    }
  });

  const submitChangeRequest = changeForm.handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await partnerApi("/legal-profile/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      changeForm.reset();
      await queryClient.invalidateQueries({ queryKey: ["partner", "me"] });
    } catch (failure) {
      setError((failure as PartnerApiError).code);
    } finally {
      setBusy(false);
    }
  });

  if (profile.isLoading) return <Loading />;
  if (profile.isError) return <Notice error={(profile.error as PartnerApiError).code} />;
  const data = profile.data!;
  const onboardingState = String(data.onboarding_state ?? "");
  const canSubmit = onboardingState === "INVITED" || onboardingState === "PROFILE_SUBMITTED";
  const legalProfile = data.legal_profile as Row | null;
  const payoutProfile = data.payout_profile as Row | null;
  const pendingChangeRequest = data.pending_legal_profile_change_request as Row | null;

  return (
    <>
      <PageTitle eyebrow="ПРОФИЛЬ" title="Ваш профиль партнёра" text="Статус онбординга, юридический статус и промокод." />
      <section className="card">
        <p>Email: <strong>{String(data.email ?? "")}</strong></p>
        <p>Статус: <Badge>{ONBOARDING_LABELS[onboardingState] ?? onboardingState}</Badge></p>
        <p>Промокод: <strong>{data.promo_code ? String(data.promo_code) : "не выдан"}</strong></p>
        <p>Делегирование ОРД: <Badge>{data.delegation_effective ? "действует" : "не действует"}</Badge></p>
      </section>

      {legalProfile && (
        <section className="card">
          <h2>Подтверждённый юридический статус</h2>
          <p>Форма: {String(legalProfile.legal_form)} · Налоговый режим: {String(legalProfile.tax_mode)}</p>
          <p>Тип контрагента: {String(legalProfile.projected_contractor_type)}</p>
          <p>{legalProfile.opf ? `${String(legalProfile.opf)} ` : ""}{String(legalProfile.full_name)}{legalProfile.short_name ? ` (${String(legalProfile.short_name)})` : ""}</p>
          <p>ИНН: {String(legalProfile.inn)}{legalProfile.kpp ? ` · КПП: ${String(legalProfile.kpp)}` : ""}{legalProfile.registration_number ? ` · ${legalProfile.legal_form === "INDIVIDUAL_ENTREPRENEUR" ? "ОГРНИП" : "ОГРН"}: ${String(legalProfile.registration_number)}` : ""}</p>
          {Boolean(legalProfile.legal_address) && <p>Адрес: {String(legalProfile.legal_address)}</p>}
        </section>
      )}

      {onboardingState === "PARTNER_ACTIVE" && (
        <section className="card">
          <h2>Изменить юридические данные</h2>
          {pendingChangeRequest ? (
            <>
              <p>
                Заявка: <Badge>{CHANGE_REQUEST_STATE_LABELS[String(pendingChangeRequest.state)] ?? String(pendingChangeRequest.state)}</Badge>
                {" → "}{String(pendingChangeRequest.legal_form)} ({String(pendingChangeRequest.tax_mode)})
              </p>
              <p>{pendingChangeRequest.opf ? `${String(pendingChangeRequest.opf)} ` : ""}{String(pendingChangeRequest.full_name)}{pendingChangeRequest.short_name ? ` (${String(pendingChangeRequest.short_name)})` : ""}, ИНН {String(pendingChangeRequest.inn)}</p>
              <p>Причина: {String(pendingChangeRequest.reason)}</p>
              <p>Заявка рассматривается администратором.</p>
            </>
          ) : (
            <form onSubmit={submitChangeRequest}>
              <label>
                Новая форма
                <select {...changeForm.register("legal_form", { required: true })}>
                  <option value="INDIVIDUAL">Физическое лицо</option>
                  <option value="INDIVIDUAL_ENTREPRENEUR">ИП</option>
                  <option value="LEGAL_ENTITY">Юридическое лицо</option>
                </select>
              </label>
              <label>
                Налоговый режим
                <select {...changeForm.register("tax_mode", { required: true })}>
                  {(TAX_MODE_OPTIONS[changeLegalForm] ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <LegalRequisitesFields legalForm={changeLegalForm} register={changeForm.register as unknown as UseFormRegister<LegalRequisitesFormFields>} />
              <label>Причина изменения <input {...changeForm.register("reason", { required: true })} /></label>
              <Notice error={error} />
              <button className="primary" disabled={busy}>{busy ? "Отправляем…" : "Подать заявку на изменение"}</button>
            </form>
          )}
        </section>
      )}

      {payoutProfile && (
        <section className="card">
          <h2>Реквизиты для выплат</h2>
          <p>{payoutProfile.kind === "ACTIVE_DESTINATION" ? `${payoutProfile.destination_kind} •••• ${payoutProfile.destination_last4}` : "отозваны"}</p>
        </section>
      )}

      {canSubmit && (
        <section className="card">
          <h2>Юридическая форма</h2>
          <form onSubmit={submitLegalProfile}>
            <label>
              Форма
              <select {...register("legal_form")}>
                <option value="INDIVIDUAL">Физическое лицо</option>
                <option value="INDIVIDUAL_ENTREPRENEUR">ИП</option>
                <option value="LEGAL_ENTITY">Юридическое лицо</option>
              </select>
            </label>
            <label>
              Налоговый режим
              <select {...register("tax_mode")}>
                {(TAX_MODE_OPTIONS[submitLegalForm] ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <LegalRequisitesFields legalForm={submitLegalForm} register={register as unknown as UseFormRegister<LegalRequisitesFormFields>} />
            <Notice error={error} />
            <button className="primary" disabled={busy}>{busy ? "Отправляем…" : "Отправить на проверку"}</button>
          </form>
        </section>
      )}
    </>
  );
}
