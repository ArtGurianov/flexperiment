"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, AdminApiError } from "../../lib/api";
import { toLocalInput } from "../../lib/values";
import type { Row } from "../../lib/page";
import { Loading } from "../ui/Loading";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";

export function Engagements({ selected, onSelect, focusDistributionId, focusReporting }: {
  selected: string | null; onSelect: (id: string | null) => void; focusDistributionId?: string | null; focusReporting?: boolean;
}) {
  return selected
    ? <EngagementDetail engagementId={selected} onBack={() => onSelect(null)} focusDistributionId={focusDistributionId ?? null} focusReporting={focusReporting ?? false} />
    : <EngagementList onSelect={onSelect} />;
}

function EngagementList({ onSelect }: { onSelect: (id: string) => void }) {
  const [partnerIdentityId, setPartnerIdentityId] = useState("");
  const engagements = useQuery({
    queryKey: ["agent-referrals", "engagements", partnerIdentityId],
    queryFn: () => api<{ engagements: Row[] }>(`/agent-referrals/engagements${partnerIdentityId ? `?partner_identity_id=${partnerIdentityId}` : ""}`),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset } = useForm<{
    partner_identity_id: string; occurrence_id: string; reward_type: "PERCENT" | "FIXED"; reward_value: number;
    customer_discount_type: "NONE" | "PERCENT" | "FIXED"; customer_discount_value: number; publication_start_at: string; publication_end_at: string;
  }>({ defaultValues: { reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000 } });

  const offer = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api("/agent-referrals/engagements", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, reward_value: Number(values.reward_value), customer_discount_value: Number(values.customer_discount_value),
          publication_start_at: new Date(values.publication_start_at).toISOString(), publication_end_at: new Date(values.publication_end_at).toISOString(), reason: "offer" }),
      });
      reset();
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  });

  return (
    <>
      <Panel title="Кампании (engagements)">
        <label>Фильтр по ID партнёра <input value={partnerIdentityId} onChange={(event) => setPartnerIdentityId(event.target.value)} /></label>
        {engagements.isLoading ? <Loading /> : engagements.isError ? <Notice error={(engagements.error as AdminApiError).code} /> : (
          <table>
            <thead><tr><th>ID</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {engagements.data!.engagements.map((row) => (
                <tr key={String(row.id)}>
                  <td>{String(row.id)}</td>
                  <td><Badge>{String(row.lifecycle_state)}</Badge></td>
                  <td><button onClick={() => onSelect(String(row.id))}>Открыть</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Предложить кампанию">
        <form className="form" onSubmit={offer}>
          <label>ID партнёра <input {...register("partner_identity_id", { required: true })} /></label>
          <label>ID события (occurrence) <input {...register("occurrence_id", { required: true })} /></label>
          <label>Тип вознаграждения <select {...register("reward_type")}><option value="PERCENT">PERCENT</option><option value="FIXED">FIXED</option></select></label>
          <label>Значение вознаграждения (basis points/копейки) <input type="number" {...register("reward_value", { required: true })} /></label>
          <label>Тип скидки <select {...register("customer_discount_type")}><option value="NONE">NONE</option><option value="PERCENT">PERCENT</option><option value="FIXED">FIXED</option></select></label>
          <label>Значение скидки <input type="number" {...register("customer_discount_value", { required: true })} /></label>
          <label>Начало публикации <input type="datetime-local" {...register("publication_start_at", { required: true })} /></label>
          <label>Конец публикации <input type="datetime-local" {...register("publication_end_at", { required: true })} /></label>
          <Notice error={error} />
          <button className="primary" disabled={busy}>{busy ? "…" : "Предложить"}</button>
        </form>
      </Panel>
    </>
  );
}

function EngagementDetail({ engagementId, onBack, focusDistributionId, focusReporting }: {
  engagementId: string; onBack: () => void; focusDistributionId: string | null; focusReporting: boolean;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["agent-referrals", "engagement", engagementId], queryFn: () => api<Row>(`/agent-referrals/engagements/${engagementId}`) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-referrals", "engagement", engagementId] });

  const post = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      refresh();
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  };

  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <Notice error={(detail.error as AdminApiError).code} />;
  const data = detail.data!;
  const engagement = data.engagement as Row;
  const lifecycleState = String(engagement.lifecycle_state);
  const latestRevision = data.latest_revision as Row | null;
  const creative = data.creative as Row | null;
  const distributions = (data.distributions as Row[]) ?? [];
  const effective = data.effective_reward_snapshot as Row | null;
  const settlement = data.settlement as Row | null;
  const act = data.act as Row | null;
  const actAcceptance = data.act_acceptance as Row | null;
  const actDispute = data.act_dispute as Row | null;
  const paymentAttempts = (data.payment_attempts as Row[]) ?? [];

  return (
    <>
      <button onClick={onBack}>← Все кампании</button>
      <Panel title={`Кампания: ${String(engagement.id)}`}>
        <p>Статус: <Badge>{lifecycleState}</Badge></p>
        {lifecycleState === "ACCEPTED" && latestRevision && (
          <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/activate`, { engagement_revision_id: latestRevision.id })}>
            {busy ? "…" : "Активировать (требует принятой редакции + подтверждённой аудитории/договора/делегирования/промокода)"}
          </button>
        )}
        {lifecycleState === "ACTIVE" && (
          <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/suspend`, { reason: "suspended by operator" })}>{busy ? "…" : "Приостановить"}</button>
        )}
        {(lifecycleState === "ACTIVE" || lifecycleState === "SUSPENDED") && (
          <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/close`, { reason: "closed by operator" })}>{busy ? "…" : "Закрыть (требует завершённого события)"}</button>
        )}
        <Notice error={error} />
      </Panel>

      <CreativeSection engagementId={engagementId} creative={creative} onDone={refresh} />
      <DistributionsSection engagementId={engagementId} distributions={distributions} onDone={refresh} focusDistributionId={focusDistributionId} focusReporting={focusReporting} />
      <RewardSection engagementId={engagementId} effective={effective} settlement={settlement} onDone={refresh} />
      {settlement && <ActPaymentSection settlement={settlement} act={act} actAcceptance={actAcceptance} actDispute={actDispute} paymentAttempts={paymentAttempts} onDone={refresh} />}
    </>
  );
}

function CreativeSection({ engagementId, creative, onDone }: { engagementId: string; creative: Row | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit } = useForm<{ format_kind: string; media_ref: string; copy_text: string; cta_text: string; mandatory_labeling_text: string; creative_target_url: string }>({
    defaultValues: { format_kind: "post", mandatory_labeling_text: "Реклама." },
  });
  const registrations = useQuery({
    queryKey: ["agent-referrals", "creative-registrations", creative?.id],
    queryFn: () => api<{ registrations: Row[] }>(`/agent-referrals/creative-revisions/${creative!.id}/registrations`),
    enabled: Boolean(creative),
  });
  const currentRegistration = registrations.data?.registrations.at(-1) ?? null;

  const run = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onDone();
      await registrations.refetch();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  const mint = handleSubmit((values) => run(`/agent-referrals/engagements/${engagementId}/creative`, values));
  const authorize = () => creative && run(`/agent-referrals/engagements/${engagementId}/creative/${creative.id}/authorize`);

  return (
    <Panel title="Креатив и регистрация в ОРД">
      {creative ? (
        <>
          <p>Формат: {String(creative.format_kind)}</p>
          <p>Ссылка: {String(creative.creative_target_url)}</p>
          <button disabled={busy} onClick={() => void authorize()}>{busy ? "…" : "Авторизовать текущий креатив"}</button>

          {!currentRegistration && (
            <button disabled={busy} onClick={() => void run(`/agent-referrals/creative-revisions/${creative.id}/register`, {})}>{busy ? "…" : "Зарегистрировать креатив в ОРД (открыть регистрацию)"}</button>
          )}
          {currentRegistration && (
            <>
              <p>Регистрация: <Badge>{String(currentRegistration.local_state)}</Badge> {currentRegistration.erid ? `· ERID ${String(currentRegistration.erid)}` : ""}</p>
              {currentRegistration.local_state === "DRAFT" && (
                <OrdSubmittedForm onSubmit={(v) => run(`/agent-referrals/ord/creative-registrations/${currentRegistration.id}/submitted`, v)} busy={busy} />
              )}
              {currentRegistration.local_state === "SUBMITTED" && (
                <OrdConfirmForm onSubmit={(v) => run(`/agent-referrals/ord/creative-registrations/${currentRegistration.id}/confirm`, v)} busy={busy} />
              )}
              {currentRegistration.local_state === "CONFIRMED" && !currentRegistration.erir_code && (
                <OrdErirForm onSubmit={(v) => run(`/agent-referrals/ord/creative-registrations/${currentRegistration.id}/erir`, v)} busy={busy} />
              )}
            </>
          )}
        </>
      ) : <p>Креатив ещё не подготовлен.</p>}
      <form className="form" onSubmit={mint}>
        <label>Формат <input {...register("format_kind", { required: true })} /></label>
        <label>Медиа-ссылка <input {...register("media_ref")} /></label>
        <label>Текст <input {...register("copy_text")} /></label>
        <label>CTA <input {...register("cta_text")} /></label>
        <label>Обязательная маркировка <input {...register("mandatory_labeling_text", { required: true })} /></label>
        <label>Целевая ссылка <input {...register("creative_target_url", { required: true })} /></label>
        <Notice error={error} />
        <button className="primary" disabled={busy}>{busy ? "…" : "Подготовить новую редакцию креатива"}</button>
      </form>
    </Panel>
  );
}

function OrdSubmittedForm({ onSubmit, busy }: { onSubmit: (v: { vk_external_id: string; evidence_ref: string }) => void; busy: boolean }) {
  const { register, handleSubmit } = useForm<{ vk_external_id: string; evidence_ref: string }>();
  return (
    <form className="form" onSubmit={handleSubmit(onSubmit)}>
      <label>Внешний ID VK <input {...register("vk_external_id", { required: true })} /></label>
      <label>Ссылка на подтверждение отправки <input {...register("evidence_ref", { required: true })} /></label>
      <button className="primary" disabled={busy}>{busy ? "…" : "Зафиксировать отправку в ОРД"}</button>
    </form>
  );
}

function OrdConfirmForm({ onSubmit, busy }: { onSubmit: (v: { vk_object_id: string; erid: string; evidence_ref: string }) => void; busy: boolean }) {
  const { register, handleSubmit } = useForm<{ vk_object_id: string; erid: string; evidence_ref: string }>();
  return (
    <form className="form" onSubmit={handleSubmit(onSubmit)}>
      <label>Object ID VK <input {...register("vk_object_id", { required: true })} /></label>
      <label>ERID <input {...register("erid", { required: true })} /></label>
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      <button className="primary" disabled={busy}>{busy ? "…" : "Зафиксировать полученный ERID"}</button>
    </form>
  );
}

function OrdErirForm({ onSubmit, busy }: { onSubmit: (v: { erir_code: string; evidence_ref: string }) => void; busy: boolean }) {
  const { register, handleSubmit } = useForm<{ erir_code: string; evidence_ref: string }>();
  return (
    <form className="form" onSubmit={handleSubmit(onSubmit)}>
      <label>Код ЕРИР <input {...register("erir_code", { required: true })} /></label>
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      <button className="primary" disabled={busy}>{busy ? "…" : "Зафиксировать сверку ЕРИР"}</button>
    </form>
  );
}

function DistributionsSection({ engagementId, distributions, onDone, focusDistributionId, focusReporting }: {
  engagementId: string; distributions: Row[]; onDone: () => void; focusDistributionId: string | null; focusReporting: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState<string | null>(null);
  // Round-4 fix: a review-queue item names one specific distribution, not merely the engagement - land
  // directly in that distribution's reporting panel when the queue item that brought us here was the
  // reporting-tail category, instead of leaving the operator to find it by hand among several rows.
  const [reporting, setReporting] = useState<string | null>(() => (focusReporting && focusDistributionId ? focusDistributionId : null));

  const run = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Размещения — приём фактов, коррекция, подтверждение снятия, отчётность">
      <table>
        <thead><tr><th>Канал</th><th>Ссылка</th><th>Комплаенс</th><th>Снятие</th><th>Действия</th></tr></thead>
        <tbody>
          {distributions.map((row) => {
            const revision = row.current_revision as Row;
            const distributionId = String(row.distribution_id);
            const focused = focusDistributionId === distributionId;
            return (
              <tr key={distributionId} className={focused ? "row-expanded" : undefined} data-focused={focused ? "true" : undefined}>
                <td>{String(revision.channel_key)}</td>
                <td>{String(revision.distribution_resource_url)}</td>
                <td><Badge>{String(row.compliance_state ?? "—")}</Badge></td>
                <td><Badge>{String(row.removal_state ?? "—")}</Badge></td>
                <td>
                  <button disabled={busy} onClick={() => setCorrecting(correcting === distributionId ? null : distributionId)}>
                    {correcting === distributionId ? "Отменить коррекцию" : "Скорректировать"}
                  </button>
                  <button disabled={busy} onClick={() => setReporting(reporting === distributionId ? null : distributionId)}>
                    {reporting === distributionId ? "Скрыть отчётность" : "Отчётность"}
                  </button>
                  {row.removal_state === null && (
                    <button disabled={busy} onClick={() => void run(`/agent-referrals/distributions/${distributionId}/require-removal`, { reason: "publication window ended" })}>Требовать снятия</button>
                  )}
                  {/* REMOVAL_CONFIRMED is legal from all four non-terminal removal states (agent-referrals-distribution.ts's own REMOVAL_LEGAL_FROM) - the confirmation form must be reachable from every one of them, not only the first two, or OVERDUE_REMOVAL/REMOVAL_UNVERIFIED become a dead end with no way back to REMOVAL_CONFIRMED. */}
                  {(row.removal_state === "REMOVAL_CLAIMED" || row.removal_state === "REMOVAL_REQUIRED" || row.removal_state === "OVERDUE_REMOVAL" || row.removal_state === "REMOVAL_UNVERIFIED") && (
                    <ConfirmRemovalForm distributionId={distributionId} busy={busy} onSubmit={(evidenceRef) => run(`/agent-referrals/distributions/${distributionId}/confirm-removal`, { evidence_ref: evidenceRef })} />
                  )}
                  {(row.removal_state === "REMOVAL_CLAIMED" || row.removal_state === "OVERDUE_REMOVAL") && (
                    <button disabled={busy} onClick={() => void run(`/agent-referrals/distributions/${distributionId}/mark-unverified`, { reason: "cannot verify" })}>Не удалось подтвердить</button>
                  )}
                  {row.compliance_state === "REVIEW_REQUIRED" && (
                    <button disabled={busy} onClick={() => void run(`/agent-referrals/distributions/${distributionId}/review-cleared`, { reason: "reviewed by operator" })}>Снять с проверки</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {correcting && (
        <DistributionFactForm
          title="Скорректировать факт размещения"
          requireCorrectionReason
          initial={(distributions.find((row) => String(row.distribution_id) === correcting)?.current_revision as Row) ?? undefined}
          busy={busy}
          onSubmit={(values) => run(`/agent-referrals/distributions/${correcting}/correct`, values)}
        />
      )}
      {reporting && (
        <DistributionReportingPanel
          reportingPeriods={(distributions.find((row) => String(row.distribution_id) === reporting)?.reporting_periods as Row[]) ?? []}
          busy={busy}
          onFile={(values) => run(`/agent-referrals/distributions/${reporting}/reports`, values)}
          onReconcile={(periodKey, values) => run(`/agent-referrals/distributions/${reporting}/reports/${periodKey}/reconciliation`, values)}
        />
      )}
      <DistributionFactForm title="Сообщить о новом размещении" busy={busy} onSubmit={(values) => run(`/agent-referrals/engagements/${engagementId}/distributions`, values)} />
      <Notice error={error} />
    </Panel>
  );
}

function DistributionReportingPanel({ reportingPeriods, busy, onFile, onReconcile }: {
  reportingPeriods: Row[]; busy: boolean;
  onFile: (values: Record<string, unknown>) => void;
  onReconcile: (periodKey: string, values: { vk_operation_external_id: string; erir_code: string; submission_evidence_ref: string }) => void;
}) {
  return (
    <div className="form">
      <h3>Отчётность по размещению (ОРД)</h3>
      {reportingPeriods.length > 0 && (
        <table>
          <thead><tr><th>Период</th><th>Основание</th><th>Ревизия</th><th>Статистика</th><th>Отправка</th></tr></thead>
          <tbody>
            {reportingPeriods.map((period) => (
              <tr key={`${String(period.reporting_period_key)}-${String(period.revision)}`}>
                <td>{String(period.reporting_period_key)}</td>
                <td>{String(period.reporting_basis)}</td>
                <td>{String(period.revision)}</td>
                <td><Badge>{String(period.statistics_state)}</Badge></td>
                <td><Badge>{String(period.submission_state)}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReportFilingForm busy={busy} onSubmit={onFile} defaultReportingBasis={reportingPeriods.at(-1)?.reporting_basis === "PROVIDER_SPECIAL_PERIOD" ? "PROVIDER_SPECIAL_PERIOD" : "CALENDAR_MONTH"} />
      <ReportReconciliationForm busy={busy} onSubmit={onReconcile} />
    </div>
  );
}

function ReportFilingForm({ busy, onSubmit, defaultReportingBasis }: { busy: boolean; onSubmit: (values: Record<string, unknown>) => void; defaultReportingBasis: "CALENDAR_MONTH" | "PROVIDER_SPECIAL_PERIOD" }) {
  const { register, handleSubmit, watch, setError, formState: { errors } } = useForm<{
    reporting_period_key: string; statistics_state: "ACTUAL" | "REPORTING_DATA_UNAVAILABLE"; statistics_json: string; evidence_ref: string; correction_reason: string;
    statistics_reason: "ORDINARY" | "ZERO_REWARD_STATISTICS" | "CONTINUING_STATISTICS"; reporting_basis: "CALENDAR_MONTH" | "PROVIDER_SPECIAL_PERIOD";
  }>({
    defaultValues: { statistics_state: "ACTUAL", statistics_reason: "ORDINARY", reporting_basis: defaultReportingBasis },
  });
  const statisticsState = watch("statistics_state");
  const statisticsReason = watch("statistics_reason");
  const reportingBasis = watch("reporting_basis");
  const submit = handleSubmit((values) => {
    let statisticsJson: Record<string, unknown> = {};
    if (values.statistics_state === "ACTUAL") {
      try {
        statisticsJson = JSON.parse(values.statistics_json || "{}") as Record<string, unknown>;
      } catch {
        setError("statistics_json", { message: "Некорректный JSON" });
        return;
      }
    }
    const statistics = values.statistics_state === "ACTUAL"
      ? { statistics_state: "ACTUAL" as const, statistics_json: statisticsJson }
      : { statistics_state: "REPORTING_DATA_UNAVAILABLE" as const };
    // The domain never accepts special_period_is_service_period for CALENDAR_MONTH (fails closed as
    // SPECIAL_PERIOD_ORDER_NOT_APPLICABLE) and always requires it for PROVIDER_SPECIAL_PERIOD + a
    // non-ORDINARY reason - and its own logic pins the value 1:1 to the reason (ZERO_REWARD_STATISTICS is
    // always the closure's own original service period; CONTINUING_STATISTICS is always a later one), so
    // there is no separate operator choice to collect here beyond reason + basis.
    const specialPeriodIsServicePeriod = values.statistics_reason !== "ORDINARY" && values.reporting_basis === "PROVIDER_SPECIAL_PERIOD"
      ? values.statistics_reason === "ZERO_REWARD_STATISTICS"
      : undefined;
    onSubmit({
      reporting_period_key: values.reporting_period_key, statistics, evidence_ref: values.evidence_ref,
      correction_reason: values.correction_reason || undefined,
      statistics_reason: values.statistics_reason === "ORDINARY" ? undefined : values.statistics_reason,
      special_period_is_service_period: specialPeriodIsServicePeriod,
    });
  });
  return (
    <form className="form" onSubmit={submit}>
      <h4>Подать отчёт за период</h4>
      <label>Период (например 2026-09) <input {...register("reporting_period_key", { required: true })} /></label>
      <label>Статистика
        <select {...register("statistics_state")}><option value="ACTUAL">Известна</option><option value="REPORTING_DATA_UNAVAILABLE">Недоступна - никогда не подставлять 0</option></select>
      </label>
      {statisticsState === "ACTUAL" && (
        <label>Данные (JSON) <textarea {...register("statistics_json")} placeholder="{}" />
          {errors.statistics_json && <p className="notice notice-error">{errors.statistics_json.message}</p>}
        </label>
      )}
      <label>Причина статистики
        <select {...register("statistics_reason")}>
          <option value="ORDINARY">Обычная</option>
          <option value="ZERO_REWARD_STATISTICS">Нулевое вознаграждение (собственный сервисный период закрытия)</option>
          <option value="CONTINUING_STATISTICS">Продолжающаяся статистика (более поздний период)</option>
        </select>
      </label>
      {statisticsReason !== "ORDINARY" && (
        <label>Основание периода
          <select {...register("reporting_basis")}>
            <option value="CALENDAR_MONTH">Календарный месяц</option>
            <option value="PROVIDER_SPECIAL_PERIOD">Особый период провайдера (ВК, требует подтверждённого L5)</option>
          </select>
        </label>
      )}
      {statisticsReason !== "ORDINARY" && reportingBasis === "PROVIDER_SPECIAL_PERIOD" && (
        <p>
          {statisticsReason === "ZERO_REWARD_STATISTICS"
            ? "Будет передано как собственный сервисный период закрытия (special_period_is_service_period = true)."
            : "Будет передано как более поздний период (special_period_is_service_period = false)."}
        </p>
      )}
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      <label>Причина коррекции (при повторной подаче за тот же период) <input {...register("correction_reason")} /></label>
      <button className="primary" disabled={busy}>{busy ? "…" : "Подать отчёт"}</button>
    </form>
  );
}

function ReportReconciliationForm({ busy, onSubmit }: { busy: boolean; onSubmit: (periodKey: string, values: { vk_operation_external_id: string; erir_code: string; submission_evidence_ref: string }) => void }) {
  const { register, handleSubmit } = useForm<{ reporting_period_key: string; vk_operation_external_id: string; erir_code: string; submission_evidence_ref: string }>();
  const submit = handleSubmit((values) => onSubmit(values.reporting_period_key, { vk_operation_external_id: values.vk_operation_external_id, erir_code: values.erir_code, submission_evidence_ref: values.submission_evidence_ref }));
  return (
    <form className="form" onSubmit={submit}>
      <h4>Сверка ЕРИР по периоду</h4>
      <label>Период <input {...register("reporting_period_key", { required: true })} /></label>
      <label>Внешний ID операции VK <input {...register("vk_operation_external_id", { required: true })} /></label>
      <label>Код ЕРИР <input {...register("erir_code", { required: true })} /></label>
      <label>Ссылка на подтверждение отправки <input {...register("submission_evidence_ref", { required: true })} /></label>
      <button className="primary" disabled={busy}>{busy ? "…" : "Зафиксировать сверку"}</button>
    </form>
  );
}

function ConfirmRemovalForm({ busy, onSubmit }: { distributionId: string; busy: boolean; onSubmit: (evidenceRef: string) => void }) {
  const { register, handleSubmit } = useForm<{ evidence_ref: string }>();
  return (
    <form className="inline-form" onSubmit={handleSubmit((v) => onSubmit(v.evidence_ref))}>
      <input placeholder="Ссылка на подтверждение снятия" {...register("evidence_ref", { required: true })} />
      <button disabled={busy}>Подтвердить снятие</button>
    </form>
  );
}

function DistributionFactForm({ title, initial, requireCorrectionReason, busy, onSubmit }: {
  title: string; initial?: Row; requireCorrectionReason?: boolean; busy: boolean;
  onSubmit: (values: { channel_key: string; resource_kind: string; resource_identifier: string; distribution_resource_url: string; published_at: string; ended_at: string | null; evidence_ref: string; correction_reason?: string }) => void;
}) {
  const { register, handleSubmit } = useForm<{ channel_key: string; resource_kind: string; resource_identifier: string; distribution_resource_url: string; published_at: string; ended_at: string; evidence_ref: string; correction_reason: string }>({
    defaultValues: {
      channel_key: initial ? String(initial.channel_key) : "", resource_kind: initial ? String(initial.resource_kind) : "channel",
      resource_identifier: initial ? String(initial.resource_identifier) : "", distribution_resource_url: initial ? String(initial.distribution_resource_url) : "",
      published_at: initial ? toLocalInput(initial.published_at) : "", ended_at: initial?.ended_at ? toLocalInput(initial.ended_at) : "",
    },
  });
  const submit = handleSubmit((values) => onSubmit({ ...values, published_at: new Date(values.published_at).toISOString(), ended_at: values.ended_at ? new Date(values.ended_at).toISOString() : null }));
  return (
    <form className="form" onSubmit={submit}>
      <h3>{title}</h3>
      <label>Канал <input {...register("channel_key", { required: true })} /></label>
      <label>Тип ресурса
        <select {...register("resource_kind")}><option value="channel">Канал</option><option value="page">Страница</option><option value="profile">Профиль</option><option value="site">Сайт</option><option value="stream">Стрим</option></select>
      </label>
      <label>Идентификатор ресурса <input {...register("resource_identifier", { required: true })} /></label>
      <label>Ссылка на публикацию <input {...register("distribution_resource_url", { required: true })} /></label>
      <label>Дата публикации <input type="datetime-local" {...register("published_at", { required: true })} /></label>
      <label>Дата окончания (если уже известна) <input type="datetime-local" {...register("ended_at")} /></label>
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      {requireCorrectionReason && <label>Причина коррекции <input {...register("correction_reason", { required: true })} /></label>}
      <button className="primary" disabled={busy}>{busy ? "…" : "Отправить"}</button>
    </form>
  );
}

function RewardSection({ engagementId, effective, settlement, onDone }: { engagementId: string; effective: Row | null; settlement: Row | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Вознаграждение и расчёт">
      {!effective && (
        <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/reward-registry/finalize`, { reason: "occurrence completed" })}>
          {busy ? "…" : "Финализировать реестр вознаграждений (требует завершённого события)"}
        </button>
      )}
      {effective && !settlement && Number(effective.reward_total_kopecks) > 0 && (
        <button disabled={busy} onClick={() => void post("/agent-referrals/settlements", { effective_reward_snapshot_id: effective.id })}>{busy ? "…" : "Подготовить расчёт (settlement)"}</button>
      )}
      {effective && !settlement && Number(effective.reward_total_kopecks) === 0 && (
        <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/zero-reward-closure`, { closure_reason: "NO_ELIGIBLE_CONVERSIONS", command_id: `admin-${engagementId}` })}>
          {busy ? "…" : "Закрыть с нулевым вознаграждением"}
        </button>
      )}
      {effective && (
        <button disabled={busy} onClick={() => void post(`/agent-referrals/engagements/${engagementId}/reward-registry/correct`, { reason: "correction by operator" })}>{busy ? "…" : "Скорректировать вознаграждение"}</button>
      )}
      {settlement && <p>Расчёт: <Badge>{String(settlement.status)}</Badge> · {Number(settlement.amount_kopecks) / 100} ₽</p>}
      <Notice error={error} />
    </Panel>
  );
}

function ActPaymentSection({ settlement, act, actAcceptance, actDispute, paymentAttempts, onDone }: {
  settlement: Row; act: Row | null; actAcceptance: Row | null; actDispute: Row | null; paymentAttempts: Row[]; onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The domain's own notion of an "active" attempt (agent-referrals-payment.ts) is any attempt whose
  // status is NOT CONFIRMED_NOT_MADE - that includes MADE, not only IN_PROGRESS/PAYOUT_UNKNOWN. A MADE
  // attempt on an NPD settlement still needs a receipt before the settlement reaches SETTLED, so dropping
  // it here would strand the operator with no way to finish a real in-flight NPD settlement.
  const activeAttempt = paymentAttempts.find((attempt) => attempt.status !== "CONFIRMED_NOT_MADE") ?? null;

  const run = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Акт и выплата">
      {!act && settlement.status === "PREPARED" && (
        <button disabled={busy} onClick={() => void run(`/agent-referrals/settlements/${settlement.id}/act`)}>{busy ? "…" : "Сформировать акт"}</button>
      )}
      {act && (
        <>
          <p>Акт: {Number(act.amount_kopecks) / 100} ₽ · {act.presented_at ? "предъявлен" : "не предъявлен"}</p>
          {!act.presented_at && <button disabled={busy} onClick={() => void run(`/agent-referrals/acts/${act.id}/present`)}>{busy ? "…" : "Предъявить акт партнёру"}</button>}
          {actAcceptance && <p>Принят партнёром {String(actAcceptance.created_at)}.</p>}
          {actDispute && <p>Оспорен партнёром: {String(actDispute.reason)}.</p>}
          {/* Begin Payment must be gated on the settlement's own status, not merely the absence of an
              active attempt in the old (IN_PROGRESS/PAYOUT_UNKNOWN-only) sense - the backend independently
              re-checks settlement.status === 'PREPARED' and refuses otherwise, so !activeAttempt alone is
              wrong once an NPD attempt reaches MADE/PENDING_DOCUMENT (settlement.status has already moved
              on there, so the settlement.status check alone already excludes it). The settlement stays
              PREPARED for the whole IN_PROGRESS/PAYOUT_UNKNOWN window though (beginPayment never touches
              settlement.status), so !activeAttempt is still required there - the backend's own
              payment_attempts_active_unique constraint would refuse a second concurrent begin, but the UI
              should not invite that click in the first place. */}
          {actAcceptance && settlement.status === "PREPARED" && !activeAttempt && (
            <button disabled={busy} onClick={() => void run("/agent-referrals/payments/begin", { settlement_id: settlement.id })}>{busy ? "…" : "Начать выплату (требует принятого акта и, для НПД, свежей проверки)"}</button>
          )}
        </>
      )}
      {activeAttempt && (
        <PaymentAttemptForm
          attempt={activeAttempt}
          settlementStatus={String(settlement.status)}
          taxModeSnapshot={settlement.tax_mode_snapshot ? String(settlement.tax_mode_snapshot) : null}
          busy={busy}
          onMade={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/made`, { evidence_ref: evidenceRef })}
          onPayoutUnknown={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/payout-unknown`, { evidence_ref: evidenceRef })}
          onConfirmedNotMade={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/confirmed-not-made`, { evidence_ref: evidenceRef })}
          onNpdReceipt={(receiptReference, evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/npd-receipt`, { receipt_reference: receiptReference, evidence_ref: evidenceRef })}
        />
      )}
      <Notice error={error} />
    </Panel>
  );
}

function PaymentAttemptForm({ attempt, settlementStatus, taxModeSnapshot, busy, onMade, onPayoutUnknown, onConfirmedNotMade, onNpdReceipt }: {
  attempt: Row; settlementStatus: string; taxModeSnapshot: string | null; busy: boolean;
  onMade: (evidenceRef: string) => void; onPayoutUnknown: (evidenceRef: string) => void; onConfirmedNotMade: (evidenceRef: string) => void;
  onNpdReceipt: (receiptReference: string, evidenceRef: string) => void;
}) {
  const { register, handleSubmit, getValues } = useForm<{ evidence_ref: string }>();
  const npdReceiptForm = useForm<{ receipt_reference: string; evidence_ref: string }>();
  const status = String(attempt.status);

  if (status === "MADE" && settlementStatus === "SETTLED") {
    return (
      <div className="form">
        <p>Попытка выплаты: <Badge>MADE</Badge> · расчёт <Badge>SETTLED</Badge>. Выплата завершена.</p>
      </div>
    );
  }

  if (status === "MADE" && taxModeSnapshot === "NPD" && settlementStatus === "PENDING_DOCUMENT") {
    return (
      <form className="form" onSubmit={npdReceiptForm.handleSubmit((values) => onNpdReceipt(values.receipt_reference, values.evidence_ref))}>
        <p>Попытка выплаты: <Badge>MADE</Badge> · расчёт ожидает чек НПД <Badge>PENDING_DOCUMENT</Badge>.</p>
        <label>Номер чека НПД <input {...npdReceiptForm.register("receipt_reference", { required: true })} /></label>
        <label>Ссылка на подтверждение <input {...npdReceiptForm.register("evidence_ref", { required: true })} /></label>
        <button className="primary" disabled={busy}>{busy ? "…" : "Записать чек НПД"}</button>
      </form>
    );
  }

  return (
    <div className="form">
      <p>Попытка выплаты: <Badge>{status}</Badge></p>
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      <button disabled={busy} onClick={handleSubmit(() => onMade(getValues("evidence_ref")))}>{busy ? "…" : "Выплата совершена"}</button>
      {status === "IN_PROGRESS" && (
        <button disabled={busy} onClick={handleSubmit(() => onPayoutUnknown(getValues("evidence_ref")))}>{busy ? "…" : "Статус неизвестен"}</button>
      )}
      <button disabled={busy} onClick={handleSubmit(() => onConfirmedNotMade(getValues("evidence_ref")))}>{busy ? "…" : "Подтверждено: выплата не совершена"}</button>
    </div>
  );
}
