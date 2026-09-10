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

const ONBOARDING_LABELS: Record<string, string> = {
  INVITED: "Приглашён", PROFILE_SUBMITTED: "Профиль отправлен", PROFILE_VERIFIED: "Профиль проверен",
  FRAMEWORK_ISSUED: "Договор выдан", FRAMEWORK_ACCEPTED: "Договор принят", PARTNER_ACTIVE: "Активен",
};

export function Partners({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  return selected ? <PartnerDetail partnerId={selected} onBack={() => onSelect(null)} /> : <PartnerList onSelect={onSelect} />;
}

function PartnerList({ onSelect }: { onSelect: (id: string) => void }) {
  const partners = useQuery({ queryKey: ["agent-referrals", "partners"], queryFn: () => api<{ partners: Row[] }>("/agent-referrals/partners") });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const { register, handleSubmit, reset } = useForm<{ agent_id: string; email: string; reason: string }>({ defaultValues: { agent_id: "", email: "", reason: "onboarding" } });

  const provision = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api("/agent-referrals/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      reset();
      await queryClient.invalidateQueries({ queryKey: ["agent-referrals", "partners"] });
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
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
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["agent-referrals", "partner", partnerId], queryFn: () => api<Row>(`/agent-referrals/partners/${partnerId}`) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-referrals", "partner", partnerId] });

  const runAction = async (path: string, body: Record<string, unknown>) => {
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
        {onboardingState === "PROFILE_VERIFIED" && <IssueFrameworkForm partnerId={partnerId} onDone={refresh} />}
        {onboardingState === "FRAMEWORK_ACCEPTED" && (
          <button disabled={busy} onClick={() => void runAction(`/agent-referrals/partners/${partnerId}/activate`, { expected_revision: identity.onboarding_revision, reason: "activated by operator" })}>
            {busy ? "…" : "Активировать партнёра (PARTNER_ACTIVE)"}
          </button>
        )}
        <Notice error={error} />
      </Panel>

      {onboardingState === "PARTNER_ACTIVE" && <PromoAndAudience partnerId={partnerId} onDone={refresh} />}
      {onboardingState === "PARTNER_ACTIVE" && (
        <LegalProfileSupersession
          partnerId={partnerId}
          legalProfile={detail.data!.legal_profile as Row | null}
          pendingRequest={detail.data!.pending_legal_profile_change_request as Row | null}
          onDone={refresh}
        />
      )}

      <Panel title="Хранение и удаление">
        <NpdCheckForm partnerId={partnerId} onDone={refresh} />
        <button disabled={busy} onClick={() => void runAction(`/agent-referrals/partners/${partnerId}/destroy`, { reason: "erasure request" })}>
          {busy ? "…" : "Удалить персональные данные (destroy)"}
        </button>
      </Panel>
    </>
  );
}

function IssueFrameworkForm({ partnerId, onDone }: { partnerId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit } = useForm<{ framework_agreement_revision_id: string; delegation_template_revision_id: string }>();
  const submit = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/framework/issue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, reason: "issued by operator" }) });
      onDone();
    } catch (failure) {
      setError((failure as AdminApiError).code);
    } finally {
      setBusy(false);
    }
  });
  return (
    <form className="form" onSubmit={submit}>
      <label>ID редакции договора <input {...register("framework_agreement_revision_id", { required: true })} /></label>
      <label>ID редакции делегирования <input {...register("delegation_template_revision_id", { required: true })} /></label>
      <Notice error={error} />
      <button className="primary" disabled={busy}>{busy ? "…" : "Выдать договор"}</button>
    </form>
  );
}

function PromoAndAudience({ partnerId, onDone }: { partnerId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const promoForm = useForm<{ code: string }>();
  const audienceForm = useForm<{ city_id: string; valid_until: string; evidence_ref: string }>();

  const mintPromo = promoForm.handleSubmit(async ({ code }) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/promo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, reason: "mint" }) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  });
  const verifyAudience = audienceForm.handleSubmit(async ({ city_id, valid_until, evidence_ref }) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/audience/${city_id}/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valid_until: new Date(valid_until).toISOString(), reason: "verified by operator", evidence_ref }),
      });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  });

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

/** D2 §10: a separate action for an already-active partner, never a repeat of onboarding verification. */
function LegalProfileSupersession({ partnerId, legalProfile, pendingRequest, onDone }: {
  partnerId: string; legalProfile: Row | null; pendingRequest: Row | null; onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset } = useForm<{ legal_form: string; tax_mode: string; reason: string; evidence_ref: string }>({
    defaultValues: { legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "", evidence_ref: "" },
  });

  const submitChange = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/legal-profile/change`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      });
      reset();
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  });

  const runOnRequest = async (action: "verify" | "reject") => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/legal-profile/change/${String(pendingRequest!.id)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: action === "verify" ? "verified by operator" : "rejected by operator" }),
      });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  };

  return (
    <Panel title="Юридические данные">
      {legalProfile && (
        <p>
          Текущий профиль: <Badge>{LEGAL_FORM_LABELS[String(legalProfile.legal_form)] ?? String(legalProfile.legal_form)}</Badge>
          {" "}({String(legalProfile.tax_mode)}), ревизия {String(legalProfile.revision)}
        </p>
      )}
      {pendingRequest ? (
        <>
          <p>
            Заявка на изменение: <Badge>{CHANGE_REQUEST_STATE_LABELS[String(pendingRequest.state)] ?? String(pendingRequest.state)}</Badge>
            {" → "}{LEGAL_FORM_LABELS[String(pendingRequest.legal_form)] ?? String(pendingRequest.legal_form)} ({String(pendingRequest.tax_mode)})
          </p>
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
            <select {...register("tax_mode", { required: true })}><option value="NPD">НПД</option><option value="OTHER">Иной</option></select>
          </label>
          <label>Причина <input {...register("reason", { required: true })} /></label>
          <label>Ссылка на подтверждающий документ (обязательно для заявки от администратора) <input {...register("evidence_ref")} /></label>
          <button className="primary" disabled={busy}>{busy ? "…" : "Изменить юридические данные"}</button>
        </form>
      )}
      <Notice error={error} />
    </Panel>
  );
}

function NpdCheckForm({ partnerId, onDone }: { partnerId: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit } = useForm<{ status: "ACTIVE" | "INACTIVE" | "UNKNOWN"; evidence_ref: string }>({ defaultValues: { status: "ACTIVE", evidence_ref: "" } });
  const submit = handleSubmit(async (values) => {
    setBusy(true); setError(null);
    try {
      await api(`/agent-referrals/partners/${partnerId}/npd-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      onDone();
    } catch (failure) { setError((failure as AdminApiError).code); } finally { setBusy(false); }
  });
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
