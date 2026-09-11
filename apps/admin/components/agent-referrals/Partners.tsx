"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm, type UseFormRegister } from "react-hook-form";
import { api, AdminApiError } from "../../lib/api";
import { useAdminMutation } from "../../lib/use-admin-mutation";
import { agentReferralsKeys } from "../../lib/query-keys";
import { usePersistentIdempotencyKey } from "../../lib/use-persistent-idempotency-key";
import type { Row } from "../../lib/page";
import {
  ALWAYS_REQUIRED_REQUISITE_FIELDS, INN_LENGTH, KPP_LENGTH, REGISTRATION_NUMBER_LENGTH, isLegalForm, requisiteRule, taxModesForLegalForm,
  type AlwaysRequiredRequisiteField, type LegalForm, type RequisiteField, type TaxMode,
} from "../../../../lib/legal-profile-rules";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { RetainedIntentNotice } from "../ui/RetainedIntentNotice";
import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

const ONBOARDING_LABELS: Record<string, string> = {
  INVITED: "Приглашён", PROFILE_SUBMITTED: "Профиль отправлен", PROFILE_VERIFIED: "Профиль проверен",
  FRAMEWORK_ISSUED: "Договор выдан", FRAMEWORK_ACCEPTED: "Договор принят", PARTNER_ACTIVE: "Активен",
};

/**
 * Every partner-scoped command in this file declares the same intent and the
 * same cache consequence, so they share one wrapper rather than repeating the
 * mutation name and the context callback nine times.
 */
function usePartnerScopedCommand<TVariables>(partnerId: string, mutationFn: (variables: TVariables) => Promise<unknown>) {
  return useAdminMutation("agentReferrals.partnerCommand", mutationFn, { context: () => ({ partnerIdentityId: partnerId }) });
}

export function Partners({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  return selected ? <PartnerDetail partnerId={selected} onBack={() => onSelect(null)} /> : <PartnerList onSelect={onSelect} />;
}

function PartnerList({ onSelect }: { onSelect: (id: string) => void }) {
  const partners = useQuery({ queryKey: agentReferralsKeys.partners(), queryFn: () => api<{ partners: Row[] }>("/agent-referrals/partners") });
  const { register, handleSubmit, reset } = useForm<{ agent_id: string; email: string; reason: string }>({ defaultValues: { agent_id: "", email: "", reason: "onboarding" } });
  const provisionPartner = useAdminMutation("agentReferrals.partnerProvision", (values: Record<string, unknown>) =>
    api("/agent-referrals/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) }));
  const busy = provisionPartner.isPending;
  const error = provisionPartner.error?.code ?? null;

  const provision = handleSubmit(async (values) => {
    await provisionPartner.mutateAsync(values).then(() => reset()).catch(() => undefined);
  });

  return (
    <>
      <Panel title="Партнёры">
        {partners.isLoading ? <Loading /> : partners.isError ? <Notice error={(partners.error as AdminApiError).code} /> : (
          <table>
            <thead><tr><th>Агент</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {partners.data!.partners.map((row) => (
                <tr key={String(row.id)}>
                  <td>{String(row.display_name)} ({String(row.slug)})</td>
                  <td><Badge>{ONBOARDING_LABELS[String(row.onboarding_state)] ?? String(row.onboarding_state)}</Badge></td>
                  <td><button onClick={() => onSelect(String(row.id))}>Открыть</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Пригласить партнёра">
        <form className="form" onSubmit={provision}>
          <label>ID агента (agents.id) <input {...register("agent_id", { required: true })} /></label>
          <label>Email <input type="email" {...register("email", { required: true })} /></label>
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "Создаём…" : "Пригласить"}</button>
        </form>
      </Panel>
    </>
  );
}

function PartnerDetail({ partnerId, onBack }: { partnerId: string; onBack: () => void }) {
  const detail = useQuery({ queryKey: agentReferralsKeys.partner(partnerId), queryFn: () => api<Row>(`/agent-referrals/partners/${partnerId}`) });
  // One hook for every partner-scoped command this panel issues: they all
  // have the same cache consequence (this partner's detail, the list column
  // that shows onboarding state, the review queue), so they declare the same
  // intent and differ only in the request they send.
  const partnerCommand = useAdminMutation("agentReferrals.partnerCommand", ({ path, body }: { path: string; body: Record<string, unknown> }) =>
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { context: () => ({ partnerIdentityId: partnerId }) });
  const busy = partnerCommand.isPending;
  const error = partnerCommand.error?.code ?? null;

  const runAction = async (path: string, body: Record<string, unknown>) => {
    await partnerCommand.mutateAsync({ path, body }).catch(() => undefined);
  };

  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <Notice error={(detail.error as AdminApiError).code} />;
  const identity = detail.data!.identity as Row;
  const onboardingState = String(identity.onboarding_state);

  return (
    <>
      <button onClick={onBack}>← Все партнёры</button>
      <Panel title={`Партнёр: ${String(identity.id)}`}>
        <p>Статус: <Badge>{ONBOARDING_LABELS[onboardingState] ?? onboardingState}</Badge></p>
        <p>Email: {String(identity.email)}</p>

        {onboardingState === "PROFILE_SUBMITTED" && (
          <button disabled={busy} onClick={() => void runAction(`/agent-referrals/partners/${partnerId}/legal-profile/verify`, { reason: "verified by operator" })}>
            {busy ? "…" : "Проверить юридический профиль"}
          </button>
        )}
        {onboardingState === "PROFILE_VERIFIED" && <IssueFrameworkForm partnerId={partnerId} />}
        {onboardingState === "FRAMEWORK_ACCEPTED" && (
          <button disabled={busy} onClick={() => void runAction(`/agent-referrals/partners/${partnerId}/activate`, { expected_revision: identity.onboarding_revision, reason: "activated by operator" })}>
            {busy ? "…" : "Активировать партнёра (PARTNER_ACTIVE)"}
          </button>
        )}
        <Notice error={error} />
      </Panel>

      <InviteRotation
        partnerId={partnerId}
        liveCapabilityId={detail.data!.live_invite_capability_id ? String(detail.data!.live_invite_capability_id) : null}
      />

      {onboardingState === "PARTNER_ACTIVE" && <PromoAndAudience partnerId={partnerId} />}
      {onboardingState === "PARTNER_ACTIVE" && (
        <LegalProfileSupersession
          partnerId={partnerId}
          legalProfile={detail.data!.legal_profile as Row | null}
          pendingRequest={detail.data!.pending_legal_profile_change_request as Row | null}
          requestHead={Number(detail.data!.legal_profile_change_request_head ?? 0)}
        />
      )}
      {detail.data!.legal_profile != null && (
        <TaxTreatmentPanel
          partnerId={partnerId}
          legalProfile={detail.data!.legal_profile as Row | null}
          taxTreatment={detail.data!.tax_treatment as Row | null}
        />
      )}

      <Panel title="Хранение и удаление">
        <NpdCheckForm partnerId={partnerId} />
        <button disabled={busy} onClick={() => void runAction(`/agent-referrals/partners/${partnerId}/destroy`, { reason: "erasure request" })}>
          {busy ? "…" : "Удалить персональные данные (destroy)"}
        </button>
      </Panel>
    </>
  );
}

function IssueFrameworkForm({ partnerId }: { partnerId: string }) {
  const { register, handleSubmit } = useForm<{ framework_agreement_revision_id: string; delegation_template_revision_id: string }>();
  const issue = usePartnerScopedCommand(partnerId, (values: Record<string, unknown>) =>
    api(`/agent-referrals/partners/${partnerId}/framework/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, reason: "issued by operator" }) }));
  const submit = handleSubmit(async (values) => { await issue.mutateAsync(values).catch(() => undefined); });
  return (
    <form className="form" onSubmit={submit}>
      <label>ID редакции договора <input {...register("framework_agreement_revision_id", { required: true })} /></label>
      <label>ID редакции делегирования <input {...register("delegation_template_revision_id", { required: true })} /></label>
      <Notice error={issue.error?.code} />
      <button className="primary" disabled={issue.isPending}>{issue.isPending ? "…" : "Выдать договор"}</button>
    </form>
  );
}

function PromoAndAudience({ partnerId }: { partnerId: string }) {
  const promoForm = useForm<{ code: string }>();
  const audienceForm = useForm<{ city_id: string; valid_until: string; evidence_ref: string }>();

  const mint = usePartnerScopedCommand(partnerId, ({ code }: { code: string }) =>
    api(`/agent-referrals/partners/${partnerId}/promo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, reason: "mint" }) }));
  // PR-C2: audience verification has no state gate of its own (unlike its
  // revoke twin), so the backend gave it durable command identity - the key
  // is what separates a deliberate re-verification from a retry, and it is
  // retained across a failure exactly like the tax-treatment panel's.
  const verifyKey = usePersistentIdempotencyKey();
  const verify = usePartnerScopedCommand(partnerId, ({ city_id, valid_until, evidence_ref }: { city_id: string; valid_until: string; evidence_ref: string }) =>
    api(`/agent-referrals/partners/${partnerId}/audience/${city_id}/verify`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": verifyKey.acquire() },
      body: JSON.stringify({ valid_until: new Date(valid_until).toISOString(), reason: "verified by operator", evidence_ref }),
    }));
  const busy = mint.isPending || verify.isPending;
  const error = mint.error?.code ?? verify.error?.code ?? null;

  const mintPromo = promoForm.handleSubmit(async (values) => { await mint.mutateAsync(values).catch(() => undefined); });
  const verifyAudience = audienceForm.handleSubmit(async (values) => { await verify.mutateAsync(values).then(() => verifyKey.clear()).catch(() => undefined); });

  return (
    <Panel title="Промокод и аудитория">
      <form className="form" onSubmit={mintPromo}>
        <label>Промокод <input {...promoForm.register("code", { required: true })} /></label>
        <button className="primary" disabled={busy}>{busy ? "…" : "Выдать промокод"}</button>
      </form>
      <form className="form" onSubmit={verifyAudience}>
        <label>ID города <input {...audienceForm.register("city_id", { required: true })} /></label>
        <label>Действует до <input type="datetime-local" {...audienceForm.register("valid_until", { required: true })} /></label>
        <label>Ссылка на подтверждение <input {...audienceForm.register("evidence_ref", { required: true })} /></label>
        <button className="primary" disabled={busy}>{busy ? "…" : "Подтвердить аудиторию города"}</button>
      </form>
      <Notice error={error} />
    </Panel>
  );
}

const LEGAL_FORM_LABELS: Record<string, string> = {
  INDIVIDUAL: "Физическое лицо (НПД)", INDIVIDUAL_ENTREPRENEUR: "ИП", LEGAL_ENTITY: "Юридическое лицо",
};
const CHANGE_REQUEST_STATE_LABELS: Record<string, string> = {
  PENDING: "На рассмотрении", VERIFIED: "Подтверждена", REJECTED: "Отклонена", STALE: "Устарела",
};

/** PR-E: the unified requisites tuple - present on every legal-profile submission (initial onboarding and D2 supersession alike). */
type LegalRequisitesFormFields = { opf: string; full_name: string; short_name: string; inn: string; kpp: string; registration_number: string; legal_address: string };

const REGISTRATION_NUMBER_LABELS: Partial<Record<LegalForm, string>> = { INDIVIDUAL_ENTREPRENEUR: "ОГРНИП", LEGAL_ENTITY: "ОГРН" };
const digitsHint = (length: number | undefined) => (length === undefined ? undefined : `${length} цифр`);

/**
 * PR-B: WHICH fields exist for a legal_form is no longer restated here - it
 * is read from the shared REQUISITE_SHAPE the domain validator itself uses
 * (lib/legal-profile-rules.ts), so a form can no longer ask for a field the
 * backend forbids, or omit one it requires, by drifting out of sync with a
 * hand-copied condition. Only the wording is this surface's own.
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

/** This surface's wording for the tax modes; WHICH of them a legal_form admits comes from the shared projection table, never from a second copy of the matrix. */
const TAX_MODE_LABELS: Record<TaxMode, string> = { NPD: "НПД", OTHER: "Иной" };
const taxModeOptions = (legalForm: string) => taxModesForLegalForm(legalForm as LegalForm).map((value) => ({ value, label: TAX_MODE_LABELS[value] }));

/** Keeps tax_mode inside the set the selected legal_form actually allows - without this, switching legal_form silently leaves a now-invalid tax_mode selected and submission fails REJECTED_COMBINATION for no reason visible in the form itself. */
function useConstrainedTaxMode(legalForm: string, taxMode: string, setValue: (name: "tax_mode", value: string) => void) {
  useEffect(() => {
    const allowed = taxModesForLegalForm(legalForm as LegalForm);
    if (allowed.length && !allowed.includes(taxMode as TaxMode)) setValue("tax_mode", allowed[0]);
  }, [legalForm, taxMode, setValue]);
}

/**
 * PR-C3: invite rotation, with the operator's INTENT chosen explicitly.
 *
 * Two buttons, one command. The raw token is never persisted, so a lost
 * response cannot be replayed - only rotated past deliberately - and the
 * only thing that differs between the two cases is the reason the audit
 * trail records. Both are pinned to the capability this screen was rendered
 * with, so a stale click is refused rather than destroying a capability
 * somebody else's rotation just created.
 */
function InviteRotation({ partnerId, liveCapabilityId }: { partnerId: string; liveCapabilityId: string | null }) {
  // Held in component state and never in the query cache: this is the one
  // moment the raw token exists outside the response.
  const [issued, setIssued] = useState<string | null>(null);

  const rotate = usePartnerScopedCommand(partnerId, (variables: { rotation_reason: string; reason: string; expected_live_capability_id: string | null }) =>
    api<{ raw_invite_token: string }>(`/agent-referrals/partners/${partnerId}/invite/reissue`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(variables),
    }));

  const run = async (rotationReason: "MANUAL_REISSUE" | "LOST_RESPONSE_RECOVERY", reason: string) => {
    setIssued(null);
    const result = await rotate.mutateAsync({ rotation_reason: rotationReason, reason, expected_live_capability_id: liveCapabilityId })
      .catch(() => undefined) as { raw_invite_token?: string } | undefined;
    if (result?.raw_invite_token) setIssued(result.raw_invite_token);
  };

  return (
    <Panel title="Приглашение">
      <p>Действующее приглашение: {liveCapabilityId ?? "нет"}</p>
      <button disabled={rotate.isPending} onClick={() => void run("MANUAL_REISSUE", "reissued by operator")}>
        Перевыпустить приглашение
      </button>
      <button disabled={rotate.isPending} onClick={() => void run("LOST_RESPONSE_RECOVERY", "previous response was lost")}>
        Ответ потерян — выпустить новый токен
      </button>
      {issued && (
        <p>
          Токен показывается один раз и нигде не сохраняется: <code>{issued}</code>
        </p>
      )}
      {/* The pin this screen was rendered with must survive an ambiguous
          outcome - re-deriving it from the refreshed detail would turn a
          retry into a new rotation against somebody else's capability. */}
      <RetainedIntentNotice
        retained={rotate.retainedIntent}
        onRetry={() => void rotate.retryRetainedIntent()}
        onDiscard={rotate.discardRetainedIntent}
        busy={rotate.isPending}
      />
      <Notice error={rotate.error?.code ?? null} />
    </Panel>
  );
}

/** D2 §10: a separate action for an already-active partner, never a repeat of onboarding verification. */
function LegalProfileSupersession({ partnerId, legalProfile, pendingRequest, requestHead }: {
  partnerId: string; legalProfile: Row | null; pendingRequest: Row | null; requestHead: number;
}) {
  // shouldUnregister: a field hidden by LegalRequisitesFields' own
  // conditional rendering (e.g. opf/kpp/legal_address when legal_form
  // switches away from LEGAL_ENTITY) must not survive in form state - RHF's
  // default keeps it, which would resubmit a stale value the backend
  // correctly refuses as AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_FORBIDDEN.
  const { register, handleSubmit, reset, watch, setValue } = useForm<{ legal_form: string; tax_mode: string; reason: string; evidence_ref: string } & LegalRequisitesFormFields>({
    shouldUnregister: true,
    defaultValues: { legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "", evidence_ref: "", opf: "", full_name: "", short_name: "", inn: "", kpp: "", registration_number: "", legal_address: "" },
  });
  const selectedLegalForm = watch("legal_form");
  const selectedTaxMode = watch("tax_mode");
  useConstrainedTaxMode(selectedLegalForm, selectedTaxMode, setValue);

  // PR-C2: both pins travel INSIDE the mutation variables, never derived
  // inside mutationFn from a query that the ambiguous-outcome refresh may
  // already have moved on - that is what lets the retained intent be
  // replayed verbatim.
  //
  // Two pins, because they cover different B*: the verified revision covers
  // "someone verified a change in between", and the request-chain head
  // covers "someone REJECTED my request" - a rejection mints no revision, so
  // it leaves the first pin untouched while freeing the pending slot.
  const submitRequest = usePartnerScopedCommand(partnerId, (values: Record<string, unknown>) =>
    api(`/agent-referrals/partners/${partnerId}/legal-profile/change`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    }));
  const resolveRequest = usePartnerScopedCommand(partnerId, (action: "verify" | "reject") =>
    api(`/agent-referrals/partners/${partnerId}/legal-profile/change/${String(pendingRequest!.id)}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: action === "verify" ? "verified by operator" : "rejected by operator" }),
    }));
  const busy = submitRequest.isPending || resolveRequest.isPending;
  const error = submitRequest.error?.code ?? resolveRequest.error?.code ?? null;

  const submitChange = handleSubmit(async (values) => {
    await submitRequest.mutateAsync({
      ...values,
      expected_current_legal_profile_revision: Number(legalProfile?.revision ?? 0),
      expected_request_sequence: requestHead,
    }).then(() => reset()).catch(() => undefined);
  });
  const runOnRequest = async (action: "verify" | "reject") => {
    await resolveRequest.mutateAsync(action).catch(() => undefined);
  };

  return (
    <Panel title="Юридические данные">
      {legalProfile && (
        <>
          <p>
            Текущий профиль: <Badge>{LEGAL_FORM_LABELS[String(legalProfile.legal_form)] ?? String(legalProfile.legal_form)}</Badge>
            {" "}({String(legalProfile.tax_mode)}), ревизия {String(legalProfile.revision)}
          </p>
          <p>{legalProfile.opf ? `${String(legalProfile.opf)} ` : ""}{String(legalProfile.full_name)}{legalProfile.short_name ? ` (${String(legalProfile.short_name)})` : ""}, ИНН {String(legalProfile.inn)}
            {legalProfile.kpp ? `, КПП ${String(legalProfile.kpp)}` : ""}{legalProfile.registration_number ? `, ${legalProfile.legal_form === "INDIVIDUAL_ENTREPRENEUR" ? "ОГРНИП" : "ОГРН"} ${String(legalProfile.registration_number)}` : ""}
          </p>
          {Boolean(legalProfile.legal_address) && <p>Адрес: {String(legalProfile.legal_address)}</p>}
        </>
      )}
      {pendingRequest ? (
        <>
          <p>
            Заявка на изменение: <Badge>{CHANGE_REQUEST_STATE_LABELS[String(pendingRequest.state)] ?? String(pendingRequest.state)}</Badge>
            {" → "}{LEGAL_FORM_LABELS[String(pendingRequest.legal_form)] ?? String(pendingRequest.legal_form)} ({String(pendingRequest.tax_mode)})
          </p>
          <p>{pendingRequest.opf ? `${String(pendingRequest.opf)} ` : ""}{String(pendingRequest.full_name)}{pendingRequest.short_name ? ` (${String(pendingRequest.short_name)})` : ""}, ИНН {String(pendingRequest.inn)}</p>
          <p>Причина: {String(pendingRequest.reason)}</p>
          <button disabled={busy} onClick={() => void runOnRequest("verify")}>{busy ? "…" : "Подтвердить изменение"}</button>{" "}
          <button disabled={busy} onClick={() => void runOnRequest("reject")}>{busy ? "…" : "Отклонить заявку"}</button>
        </>
      ) : (
        <form className="form" onSubmit={submitChange}>
          <label>Новая форма
            <select {...register("legal_form", { required: true })}>
              <option value="INDIVIDUAL">Физическое лицо (НПД)</option>
              <option value="INDIVIDUAL_ENTREPRENEUR">ИП</option>
              <option value="LEGAL_ENTITY">Юридическое лицо</option>
            </select>
          </label>
          <label>Налоговый режим
            <select {...register("tax_mode", { required: true })}>{taxModeOptions(selectedLegalForm).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </label>
          <LegalRequisitesFields legalForm={selectedLegalForm} register={register as unknown as UseFormRegister<LegalRequisitesFormFields>} />
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <label>Ссылка на подтверждающий документ (обязательно для заявки от администратора) <input {...register("evidence_ref")} /></label>
          <button className="primary" disabled={busy}>{busy ? "…" : "Изменить юридические данные"}</button>
        </form>
      )}
      <RetainedIntentNotice
        retained={submitRequest.retainedIntent}
        onRetry={() => void submitRequest.retryRetainedIntent()}
        onDiscard={submitRequest.discardRetainedIntent}
        busy={busy}
      />
      <Notice error={error} />
    </Panel>
  );
}

const TAX_SYSTEM_LABELS: Record<string, string> = { NPD: "НПД", USN: "УСН", AUSN: "АУСН", OSNO: "ОСНО", PSN: "ПСН", ESHN: "ЕСХН", OTHER: "Другое" };
const VAT_TREATMENT_LABELS: Record<string, string> = { NO_VAT: "Без НДС", VAT_5: "5%", VAT_7: "7%", VAT_22: "22%" };

/**
 * Admin never asserts NPD directly - it is minted automatically alongside
 * the legal profile (agent-referrals-tax-treatment.ts's own SYSTEM_DERIVED
 * mint). PSN (patent system) is individual-entrepreneur-only under Russian
 * law - offered only when the partner's current legal profile is genuinely
 * INDIVIDUAL_ENTREPRENEUR, mirroring the backend's own relational-
 * consistency trigger and recordVerifiedTaxTreatment's own explicit check.
 */
const adminTaxSystemOptions = (legalForm: string | undefined): string[] =>
  legalForm === "INDIVIDUAL_ENTREPRENEUR" ? ["USN", "AUSN", "PSN", "OSNO", "ESHN", "OTHER"] : ["USN", "AUSN", "OSNO", "ESHN", "OTHER"];

/** Mirrors 0053's own tax_system x vat_treatment matrix (commerce/src/agent-referrals-tax-treatment.ts's validateTaxTreatmentTuple). no_vat_basis is derived from tax_system, never a separate form field - each tax_system has exactly one meaningful "no VAT" reason. */
const vatOptionsForTaxSystem = (taxSystem: string): Array<{ value: string; label: string }> => {
  if (taxSystem === "AUSN") return [{ value: "NO_VAT", label: "Без НДС (АУСН)" }];
  if (taxSystem === "PSN") return [{ value: "NO_VAT", label: "Без НДС (ПСН)" }];
  if (taxSystem === "USN") return [{ value: "NO_VAT", label: "Без НДС (освобождение УСН)" }, { value: "VAT_5", label: "5%" }, { value: "VAT_7", label: "7%" }, { value: "VAT_22", label: "22%" }];
  return [{ value: "VAT_22", label: "22%" }, { value: "NO_VAT", label: "Без НДС (подтверждённое освобождение)" }];
};
const noVatBasisForTaxSystem = (taxSystem: string): string =>
  taxSystem === "USN" ? "USN_EXEMPT" : taxSystem === "AUSN" ? "AUSN" : taxSystem === "PSN" ? "PSN" : "OTHER_CONFIRMED";

/** Keeps vat_treatment inside the set the selected tax_system actually allows - without this, switching tax_system (e.g. USN/VAT_5 -> AUSN) silently leaves a now-invalid vat_treatment selected and submission fails MATRIX_REJECTED for no reason visible in the form itself. */
function useConstrainedVatTreatment(taxSystem: string, vatTreatment: string, setValue: (name: "vat_treatment", value: string) => void) {
  useEffect(() => {
    const allowed = vatOptionsForTaxSystem(taxSystem).map((o) => o.value);
    if (allowed.length && !allowed.includes(vatTreatment)) setValue("vat_treatment", allowed[0]);
  }, [taxSystem, vatTreatment, setValue]);
}

/**
 * PR-F: recording a non-NPD tax/VAT treatment - always targets the
 * partner's CURRENT legal profile, resolved server-side. NPD boundary
 * (review round 2): a legal profile whose OWN tax_mode is NPD has its tax
 * treatment fixed exclusively by the automatic SYSTEM_DERIVED mint
 * (mintSystemDerivedNpdTaxTreatment) - recordVerifiedTaxTreatment refuses
 * ANY admin-asserted tax_system for such a profile (even one that is
 * otherwise structurally valid, like USN), so the form is never offered
 * for one; only the read-only current-treatment display is shown.
 */
function TaxTreatmentPanel({ partnerId, legalProfile, taxTreatment }: { partnerId: string; legalProfile: Row | null; taxTreatment: Row | null }) {
  const { register, handleSubmit, reset, watch, setValue } = useForm<{ tax_system: string; vat_treatment: string; effective_from: string; evidence_ref: string; reason: string }>({
    defaultValues: { tax_system: "USN", vat_treatment: "NO_VAT", effective_from: "", evidence_ref: "", reason: "" },
  });
  const selectedTaxSystem = watch("tax_system");
  const selectedVatTreatment = watch("vat_treatment");
  useConstrainedVatTreatment(selectedTaxSystem, selectedVatTreatment, setValue);
  const taxSystemOptions = adminTaxSystemOptions(legalProfile?.legal_form as string | undefined);
  const isNpdProfile = legalProfile?.tax_mode === "NPD";
  // Backend command identity (review round 3): the SAME key must be
  // retained across a failed submission's retry, and only rotated after a
  // genuine success - otherwise a second, DISTINCT assertion made from
  // this same still-mounted panel would collide as IDEMPOTENCY_CONFLICT.
  const commandKey = usePersistentIdempotencyKey();

  // The ONLY agent-referrals route that carries durable command identity
  // (PR-F round 3): the key is retained across a failed retry by
  // usePersistentIdempotencyKey and rotated only after a genuine success.
  const record = usePartnerScopedCommand(partnerId, (values: { tax_system: string; vat_treatment: string }) =>
    api(`/agent-referrals/partners/${partnerId}/tax-treatment`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": commandKey.acquire() },
      body: JSON.stringify({ ...values, no_vat_basis: values.vat_treatment === "NO_VAT" ? noVatBasisForTaxSystem(values.tax_system) : null }),
    }));
  const busy = record.isPending;
  const error = record.error?.code ?? null;

  const submit = handleSubmit(async (values) => {
    await record.mutateAsync(values).then(() => { commandKey.clear(); reset(); }).catch(() => undefined);
  });

  return (
    <Panel title="Налоговый режим / НДС">
      {taxTreatment ? (
        <p>
          Текущий: <Badge>{TAX_SYSTEM_LABELS[String(taxTreatment.tax_system)] ?? String(taxTreatment.tax_system)}</Badge>
          {" "}{VAT_TREATMENT_LABELS[String(taxTreatment.vat_treatment)] ?? String(taxTreatment.vat_treatment)}, действует с {String(taxTreatment.effective_from)}
        </p>
      ) : (
        <p>Налоговый режим ещё не зафиксирован для текущего юридического профиля.</p>
      )}
      {isNpdProfile ? (
        <p>Текущий юридический профиль — НПД: налоговый режим фиксируется автоматически, ручная запись недоступна.</p>
      ) : (
        <form className="form" onSubmit={submit}>
          <label>Система налогообложения
            <select {...register("tax_system", { required: true })}>
              {taxSystemOptions.map((s) => <option key={s} value={s}>{TAX_SYSTEM_LABELS[s]}</option>)}
            </select>
          </label>
          <label>НДС
            <select {...register("vat_treatment", { required: true })}>
              {vatOptionsForTaxSystem(selectedTaxSystem).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>Действует с <input type="date" {...register("effective_from", { required: true })} /></label>
          <label>Ссылка на подтверждающий документ <input {...register("evidence_ref", { required: true })} /></label>
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "…" : "Зафиксировать налоговый режим"}</button>
        </form>
      )}
    </Panel>
  );
}

function NpdCheckForm({ partnerId }: { partnerId: string }) {
  const { register, handleSubmit } = useForm<{ status: "ACTIVE" | "INACTIVE" | "UNKNOWN"; evidence_ref: string }>({ defaultValues: { status: "ACTIVE", evidence_ref: "" } });
  // PR-C2: a fresh check with the same status is a legitimate new command -
  // the payment guard consumes freshness - so only the key distinguishes it
  // from a retry.
  const recordKey = usePersistentIdempotencyKey();
  const record = usePartnerScopedCommand(partnerId, (values: Record<string, unknown>) =>
    api(`/agent-referrals/partners/${partnerId}/npd-status`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": recordKey.acquire() }, body: JSON.stringify(values) }));
  const busy = record.isPending;
  const error = record.error?.code ?? null;
  const submit = handleSubmit(async (values) => { await record.mutateAsync(values).then(() => recordKey.clear()).catch(() => undefined); });
  return (
    <form className="form" onSubmit={submit}>
      <label>Статус НПД
        <select {...register("status")}><option value="ACTIVE">ACTIVE</option><option value="INACTIVE">INACTIVE</option><option value="UNKNOWN">UNKNOWN</option></select>
      </label>
      <label>Ссылка на подтверждение (ручная проверка ФНС) <input {...register("evidence_ref", { required: true })} /></label>
      <Notice error={error} />
      <button className="primary" disabled={busy}>{busy ? "…" : "Записать проверку НПД"}</button>
    </form>
  );
}
