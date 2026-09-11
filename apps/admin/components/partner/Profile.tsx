"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import { partnerApi, PartnerApiError } from "../../lib/partner-api";
import { usePartnerMutation } from "../../lib/use-partner-mutation";
import { partnerKeys } from "../../lib/query-keys";
import type { Row } from "../../lib/partner-page";
import {
  ALWAYS_REQUIRED_REQUISITE_FIELDS, INN_LENGTH, KPP_LENGTH, REGISTRATION_NUMBER_LENGTH, isLegalForm, requisiteRule, taxModesForLegalForm,
  type AlwaysRequiredRequisiteField, type LegalForm, type RequisiteField, type TaxMode,
} from "../../../../lib/legal-profile-rules";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { RetainedIntentNotice } from "../ui/RetainedIntentNotice";
import { PageTitle } from "../ui/PageTitle";
import { Badge } from "../ui/Badge";

const ONBOARDING_LABELS: Record<string, string> = {
  INVITED: "Приглашён", PROFILE_SUBMITTED: "Профиль отправлен", PROFILE_VERIFIED: "Профиль проверен",
  FRAMEWORK_ISSUED: "Договор выдан", FRAMEWORK_ACCEPTED: "Договор принят", PARTNER_ACTIVE: "Активен",
};

const CHANGE_REQUEST_STATE_LABELS: Record<string, string> = {
  PENDING: "На рассмотрении", VERIFIED: "Подтверждена", REJECTED: "Отклонена", STALE: "Устарела",
};

/** PR-F: read-only display labels - the partner never asserts a tax treatment directly (no self-service candidate lifecycle exists for it, unlike legal-profile supersession above). */
const TAX_SYSTEM_LABELS: Record<string, string> = { NPD: "НПД", USN: "УСН", AUSN: "АУСН", OSNO: "ОСНО", PSN: "ПСН", ESHN: "ЕСХН", OTHER: "Другое" };
const VAT_TREATMENT_LABELS: Record<string, string> = { NO_VAT: "Без НДС", VAT_5: "5%", VAT_7: "7%", VAT_22: "22%" };

/** PR-E: the unified requisites tuple - present on every legal-profile submission (initial onboarding and D2 supersession alike). */
type LegalRequisitesFormFields = { opf: string; full_name: string; short_name: string; inn: string; kpp: string; registration_number: string; legal_address: string };

/** This surface's wording for the tax modes; WHICH of them a legal_form admits comes from the shared projection table, never from a second copy of the matrix. */
const TAX_MODE_LABELS: Record<TaxMode, string> = { NPD: "НПД (самозанятый)", OTHER: "Другой" };
const taxModeOptions = (legalForm: string) => taxModesForLegalForm(legalForm as LegalForm).map((value) => ({ value, label: TAX_MODE_LABELS[value] }));

/** Keeps tax_mode inside the set the selected legal_form actually allows - without this, switching legal_form silently leaves a now-invalid tax_mode selected and the submission fails REJECTED_COMBINATION for no reason visible in the form itself. */
function useConstrainedTaxMode(legalForm: string, taxMode: string, setValue: (name: "tax_mode", value: string) => void) {
  useEffect(() => {
    const allowed = taxModesForLegalForm(legalForm as LegalForm);
    if (allowed.length && !allowed.includes(taxMode as TaxMode)) setValue("tax_mode", allowed[0]);
  }, [legalForm, taxMode, setValue]);
}

const REGISTRATION_NUMBER_LABELS: Partial<Record<LegalForm, string>> = { INDIVIDUAL_ENTREPRENEUR: "ОГРНИП", LEGAL_ENTITY: "ОГРН" };
const digitsHint = (length: number | undefined) => (length === undefined ? undefined : `${length} цифр`);

/**
 * PR-B: WHICH fields exist for a legal_form is no longer restated here - it
 * is read from the shared REQUISITE_SHAPE the domain validator itself uses
 * (lib/legal-profile-rules.ts), so a partner can no longer be shown a field
 * the backend forbids, or asked for one it requires, by drifting out of sync
 * with a hand-copied condition. Only the wording is this surface's own.
 */
function LegalRequisitesFields({ legalForm, register }: { legalForm: string; register: UseFormRegister<LegalRequisitesFormFields> }) {
  const form = isLegalForm(legalForm) ? legalForm : null;
  const alwaysRequired = (field: AlwaysRequiredRequisiteField) => ALWAYS_REQUIRED_REQUISITE_FIELDS.includes(field);
  const shown = (field: RequisiteField) => requisiteRule(legalForm, field) !== "FORBIDDEN";
  const required = (field: RequisiteField) => requisiteRule(legalForm, field) === "REQUIRED";
  return (
    <>
      <label>ФИО / полное наименование <input {...register("full_name", { required: alwaysRequired("full_name") })} /></label>
      {shown("short_name") && <label>Сокращённое наименование <input {...register("short_name", { required: required("short_name") })} /></label>}
      {shown("opf") && <label>ОПФ <input {...register("opf", { required: required("opf") })} placeholder="ООО" /></label>}
      <label>ИНН <input {...register("inn", { required: alwaysRequired("inn") })} placeholder={digitsHint(form ? INN_LENGTH[form] : undefined)} /></label>
      {shown("kpp") && <label>КПП <input {...register("kpp", { required: required("kpp") })} placeholder={digitsHint(KPP_LENGTH)} /></label>}
      {shown("registration_number") && (
        <label>{(form && REGISTRATION_NUMBER_LABELS[form]) ?? "Регистрационный номер"} <input {...register("registration_number", { required: required("registration_number") })} placeholder={digitsHint(form ? REGISTRATION_NUMBER_LENGTH[form] : undefined)} /></label>
      )}
      {shown("legal_address") && <label>Юридический адрес <input {...register("legal_address", { required: required("legal_address") })} /></label>}
    </>
  );
}

export function Profile() {
  const profile = useQuery({ queryKey: partnerKeys.me(), queryFn: () => partnerApi<Row>("/me") });
  const submit = usePartnerMutation("partner.legalProfileSubmit", (body: Record<string, unknown>) =>
    partnerApi("/legal-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const change = usePartnerMutation("partner.legalProfileChange", (body: Record<string, unknown>) =>
    partnerApi("/legal-profile/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const busy = submit.isPending || change.isPending;
  const error = submit.error?.code ?? change.error?.code ?? null;
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

  // The mutation hook owns busy/error/invalidation; the handler only says
  // what to send. A failure is not swallowed here - it is rendered from the
  // hook's own error below, and an ambiguous one has already triggered an
  // authoritative refresh by the time it lands there.
  //
  // PR-C2: both commands carry the version this screen was rendered from.
  // The draft counter, not the draft's content: editing the draft and
  // editing it back would restore a content pin to exactly what a stale
  // retry was authored against, and the counter never goes backwards.
  const submitLegalProfile = handleSubmit(async (values) => {
    await submit.mutateAsync({ ...values, expected_draft_revision: Number(profile.data?.legal_profile_draft_revision ?? 0) }).catch(() => undefined);
  });
  const submitChangeRequest = changeForm.handleSubmit(async (values) => {
    await change.mutateAsync({
      ...values,
      expected_current_legal_profile_revision: Number((profile.data?.legal_profile as Row | null)?.revision ?? 0),
      // The second pin: a REJECTION of an earlier request moves no revision
      // but frees the pending slot, so the revision alone cannot tell a
      // retry from a deliberate re-application after a refusal.
      expected_request_sequence: Number(profile.data?.legal_profile_change_request_head ?? 0),
    }).then(() => changeForm.reset()).catch(() => undefined);
  });

  if (profile.isLoading) return <Loading />;
  if (profile.isError) return <Notice error={(profile.error as PartnerApiError).code} />;
  const data = profile.data!;
  const onboardingState = String(data.onboarding_state ?? "");
  const canSubmit = onboardingState === "INVITED" || onboardingState === "PROFILE_SUBMITTED";
  const legalProfile = data.legal_profile as Row | null;
  const payoutProfile = data.payout_profile as Row | null;
  const pendingChangeRequest = data.pending_legal_profile_change_request as Row | null;
  const taxTreatment = data.tax_treatment as Row | null;

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

      {taxTreatment && (
        <section className="card">
          <h2>Налоговый режим</h2>
          <p>
            {TAX_SYSTEM_LABELS[String(taxTreatment.tax_system)] ?? String(taxTreatment.tax_system)}
            {" · "}
            {VAT_TREATMENT_LABELS[String(taxTreatment.vat_treatment)] ?? String(taxTreatment.vat_treatment)}
          </p>
          <p>Действует с {String(taxTreatment.effective_from)}</p>
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
                  {taxModeOptions(changeLegalForm).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <LegalRequisitesFields legalForm={changeLegalForm} register={changeForm.register as unknown as UseFormRegister<LegalRequisitesFormFields>} />
              <label>Причина изменения <input {...changeForm.register("reason", { required: true })} /></label>
              <RetainedIntentNotice
                retained={change.retainedIntent}
                onRetry={() => void change.retryRetainedIntent()}
                onDiscard={change.discardRetainedIntent}
                busy={busy}
              />
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
                {taxModeOptions(submitLegalForm).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <LegalRequisitesFields legalForm={submitLegalForm} register={register as unknown as UseFormRegister<LegalRequisitesFormFields>} />
            {/* Its OWN notice, not shared with the supersession panel below.
                They are different intents, and this one has to be reachable
                from the state the initial submission actually leaves behind:
                an ambiguous first submit moves onboarding INVITED ->
                PROFILE_SUBMITTED, which keeps this form on screen and never
                renders the PARTNER_ACTIVE section at all. Without a notice
                here, the operator's only route back is an ordinary submit -
                which would re-derive expected_draft_revision from the
                refreshed profile and stop being a retry. */}
            <RetainedIntentNotice
              retained={submit.retainedIntent}
              onRetry={() => void submit.retryRetainedIntent()}
              onDiscard={submit.discardRetainedIntent}
              busy={busy}
            />
            <Notice error={error} />
            <button className="primary" disabled={busy}>{busy ? "Отправляем…" : "Отправить на проверку"}</button>
          </form>
        </section>
      )}
    </>
  );
}
