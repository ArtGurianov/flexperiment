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

export function Engagements({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  return selected ? <EngagementDetail engagementId={selected} onBack={() => onSelect(null)} /> : <EngagementList onSelect={onSelect} />;
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

function EngagementDetail({ engagementId, onBack }: { engagementId: string; onBack: () => void }) {
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
      <DistributionsSection engagementId={engagementId} distributions={distributions} onDone={refresh} />
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

function DistributionsSection({ engagementId, distributions, onDone }: { engagementId: string; distributions: Row[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState<string | null>(null);

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
            return (
              <tr key={distributionId}>
                <td>{String(revision.channel_key)}</td>
                <td>{String(revision.distribution_resource_url)}</td>
                <td><Badge>{String(row.compliance_state ?? "—")}</Badge></td>
                <td><Badge>{String(row.removal_state ?? "—")}</Badge></td>
                <td>
                  <button disabled={busy} onClick={() => setCorrecting(correcting === distributionId ? null : distributionId)}>
                    {correcting === distributionId ? "Отменить коррекцию" : "Скорректировать"}
                  </button>
                  {row.removal_state === null && (
                    <button disabled={busy} onClick={() => void run(`/agent-referrals/distributions/${distributionId}/require-removal`, { reason: "publication window ended" })}>Требовать снятия</button>
                  )}
                  {(row.removal_state === "REMOVAL_CLAIMED" || row.removal_state === "REMOVAL_REQUIRED") && (
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
      <DistributionFactForm title="Сообщить о новом размещении" busy={busy} onSubmit={(values) => run(`/agent-referrals/engagements/${engagementId}/distributions`, values)} />
      <Notice error={error} />
    </Panel>
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
  onSubmit: (values: { channel_key: string; resource_kind: string; resource_identifier: string; distribution_resource_url: string; published_at: string; evidence_ref: string; correction_reason?: string }) => void;
}) {
  const { register, handleSubmit } = useForm<{ channel_key: string; resource_kind: string; resource_identifier: string; distribution_resource_url: string; published_at: string; evidence_ref: string; correction_reason: string }>({
    defaultValues: {
      channel_key: initial ? String(initial.channel_key) : "", resource_kind: initial ? String(initial.resource_kind) : "channel",
      resource_identifier: initial ? String(initial.resource_identifier) : "", distribution_resource_url: initial ? String(initial.distribution_resource_url) : "",
      published_at: initial ? toLocalInput(initial.published_at) : "",
    },
  });
  const submit = handleSubmit((values) => onSubmit({ ...values, published_at: new Date(values.published_at).toISOString() }));
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
  const activeAttempt = paymentAttempts.find((attempt) => attempt.status === "IN_PROGRESS" || attempt.status === "PAYOUT_UNKNOWN") ?? null;

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
          {actAcceptance && !activeAttempt && (
            <button disabled={busy} onClick={() => void run("/agent-referrals/payments/begin", { settlement_id: settlement.id })}>{busy ? "…" : "Начать выплату (требует принятого акта и, для НПД, свежей проверки)"}</button>
          )}
        </>
      )}
      {activeAttempt && (
        <PaymentAttemptForm attempt={activeAttempt} busy={busy}
          onMade={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/made`, { evidence_ref: evidenceRef })}
          onPayoutUnknown={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/payout-unknown`, { evidence_ref: evidenceRef })}
          onConfirmedNotMade={(evidenceRef) => run(`/agent-referrals/payment-attempts/${activeAttempt.id}/confirmed-not-made`, { evidence_ref: evidenceRef })}
        />
      )}
      <Notice error={error} />
    </Panel>
  );
}

function PaymentAttemptForm({ attempt, busy, onMade, onPayoutUnknown, onConfirmedNotMade }: {
  attempt: Row; busy: boolean; onMade: (evidenceRef: string) => void; onPayoutUnknown: (evidenceRef: string) => void; onConfirmedNotMade: (evidenceRef: string) => void;
}) {
  const { register, handleSubmit, getValues } = useForm<{ evidence_ref: string }>();
  return (
    <div className="form">
      <p>Попытка выплаты: <Badge>{String(attempt.status)}</Badge></p>
      <label>Ссылка на подтверждение <input {...register("evidence_ref", { required: true })} /></label>
      <button disabled={busy} onClick={handleSubmit(() => onMade(getValues("evidence_ref")))}>{busy ? "…" : "Выплата совершена"}</button>
      {attempt.status === "IN_PROGRESS" && (
        <button disabled={busy} onClick={handleSubmit(() => onPayoutUnknown(getValues("evidence_ref")))}>{busy ? "…" : "Статус неизвестен"}</button>
      )}
      <button disabled={busy} onClick={handleSubmit(() => onConfirmedNotMade(getValues("evidence_ref")))}>{busy ? "…" : "Подтверждено: выплата не совершена"}</button>
    </div>
  );
}
