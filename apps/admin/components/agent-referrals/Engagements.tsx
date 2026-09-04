"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { api, AdminApiError } from "../../lib/api";
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
      <DistributionsSection distributions={distributions} onDone={refresh} />
      <RewardSection engagementId={engagementId} effective={effective} settlement={settlement} onDone={refresh} />
    </>
  );
}

function CreativeSection({ engagementId, creative, onDone }: { engagementId: string; creative: Row | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit } = useForm<{ format_kind: string; media_ref: string; copy_text: string; cta_text: string; mandatory_labeling_text: string; creative_target_url: string }>({
    defaultValues: { format_kind: "post", mandatory_labeling_text: "Реклама." },
  });

  const mint = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/engagements/${engagementId}/creative`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  });

  const authorize = async () => {
    if (!creative) return;
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/engagements/${engagementId}/creative/${creative.id}/authorize`, { method: "POST" });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Креатив">
      {creative ? (
        <>
          <p>Формат: {String(creative.format_kind)}</p>
          <p>Ссылка: {String(creative.creative_target_url)}</p>
          <button disabled={busy} onClick={() => void authorize()}>{busy ? "…" : "Авторизовать текущий креатив"}</button>
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

function DistributionsSection({ distributions, onDone }: { distributions: Row[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Размещения — приём фактов, коррекция, подтверждение снятия">
      <table>
        <thead><tr><th>Канал</th><th>Комплаенс</th><th>Снятие</th><th>Действия</th></tr></thead>
        <tbody>
          {distributions.map((row) => {
            const revision = row.current_revision as Row;
            const distributionId = String(row.distribution_id);
            return (
              <tr key={distributionId}>
                <td>{String(revision.channel_key)}</td>
                <td><Badge>{String(row.compliance_state ?? "—")}</Badge></td>
                <td><Badge>{String(row.removal_state ?? "—")}</Badge></td>
                <td>
                  {row.removal_state === null && (
                    <button disabled={busy} onClick={() => void act(`/agent-referrals/distributions/${distributionId}/require-removal`, { reason: "publication window ended" })}>Требовать снятия</button>
                  )}
                  {(row.removal_state === "REMOVAL_CLAIMED" || row.removal_state === "REMOVAL_REQUIRED") && (
                    <button disabled={busy} onClick={() => void act(`/agent-referrals/distributions/${distributionId}/confirm-removal`, { evidence_ref: "operator-verified" })}>Подтвердить снятие</button>
                  )}
                  {(row.removal_state === "REMOVAL_CLAIMED" || row.removal_state === "OVERDUE_REMOVAL") && (
                    <button disabled={busy} onClick={() => void act(`/agent-referrals/distributions/${distributionId}/mark-unverified`, { reason: "cannot verify" })}>Не удалось подтвердить</button>
                  )}
                  {row.compliance_state === "REVIEW_REQUIRED" && (
                    <button disabled={busy} onClick={() => void act(`/agent-referrals/distributions/${distributionId}/review-cleared`, { reason: "reviewed by operator" })}>Снять с проверки</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Notice error={error} />
    </Panel>
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
    <Panel title="Вознаграждение, расчёт, акт, выплата">
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
      {settlement && (
        <>
          <p>Расчёт: <Badge>{String(settlement.status)}</Badge> · {Number(settlement.amount_kopecks) / 100} ₽</p>
          {settlement.status === "PREPARED" && (
            <button disabled={busy} onClick={() => void post(`/agent-referrals/settlements/${settlement.id}/act`)}>{busy ? "…" : "Сформировать акт"}</button>
          )}
        </>
      )}
      <Notice error={error} />
    </Panel>
  );
}
