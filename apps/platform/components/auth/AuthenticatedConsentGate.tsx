"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

type Status = { storefront: "COURSES"; verifiedAccount: boolean; requiredChoicesConfirmed: boolean;
  releaseVersion: string | null; manifestSha256: string | null;
  actionSequence: number; action?: { key: string; outcome: "COMMITTED" | "ABSENT" };
  documents: Array<{ kind: string; version: string; sha256: string; url: string }> };
const path = "/v1/me/consents?storefront=COURSES";
const readStatus = async (signal?: AbortSignal, actionKey?: string) => {
  const response = await fetch(actionKey ? `${path}&actionKey=${encodeURIComponent(actionKey)}` : path,
    { cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new Error("CONSENT_STATUS_UNAVAILABLE");
  const status = await response.json() as Status;
  if (status.storefront !== "COURSES" || typeof status.verifiedAccount !== "boolean"
    || typeof status.requiredChoicesConfirmed !== "boolean" || !Number.isSafeInteger(status.actionSequence) || status.actionSequence < 0
    || !Array.isArray(status.documents)) throw new Error("CONSENT_STATUS_INVALID");
  if (actionKey && (status.action?.key !== actionKey || !["COMMITTED", "ABSENT"].includes(status.action.outcome))) {
    throw new Error("CONSENT_ACTION_STATUS_INVALID");
  }
  return status;
};
// Only application errors known to occur before insertion/inside a rolled-back transaction.
// HTTP status alone (including a proxy's 4xx/5xx) never proves a no-write outcome.
const noWriteErrors = new Set(["AUTHENTICATED_CONSENT_INPUT_INVALID", "CONSENT_INPUT_TOO_LARGE", "STOREFRONT_INVALID",
  "ORIGIN_FORBIDDEN", "CONSENT_PRECONDITION_REQUIRED", "VERIFIED_ACCOUNT_REQUIRED", "LEGAL_RELEASE_NOT_FOUND",
  "LEGAL_RELEASE_INCOMPLETE", "LEGAL_RELEASE_STALE", "CONSENT_STATE_STALE"]);

export default function AuthenticatedConsentGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void readStatus(controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  if (error) return <p role="alert">Не удалось проверить согласия. Доступ к курсам пока закрыт. Обновите страницу.</p>;
  if (!status) return <p role="status">Проверяем подтверждения аккаунта…</p>;
  if (!status.verifiedAccount) return <p role="alert">Для доступа нужен подтверждённый email. Войдите заново.</p>;
  if (status.requiredChoicesConfirmed) return <>{children}</>;
  return <ConsentForm key={`${status.releaseVersion}:${status.manifestSha256}`} status={status} onStatus={setStatus} />;
}

function ConsentForm({ status, onStatus }: { status: Status; onStatus: (status: Status) => void }) {
  const active = useRef(true);
  const busy = useRef(false);
  const actionKey = useRef<string | null>(null);
  const definitiveRejection = useRef(false);
  const [phase, setPhase] = useState<"idle" | "saving" | "uncertain" | "retryable">("idle");
  const [formEpoch, setFormEpoch] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const docs = new Map(status.documents.map(document => [document.kind, document]));
  const ready = Boolean(status.releaseVersion && status.manifestSha256 && /^[a-f0-9]{64}$/.test(status.manifestSha256)
    && ["privacy", "personal_data", "account_terms", "marketing_consent"].every(kind => docs.has(kind)));
  const applyReadBack = (fresh: Status) => {
    if (!active.current) return;
    const rotated = fresh.releaseVersion !== status.releaseVersion || fresh.manifestSha256 !== status.manifestSha256;
    if (!rotated && !fresh.requiredChoicesConfirmed && fresh.action?.outcome === "ABSENT") {
      setPhase("retryable");
      setMessage(definitiveRejection.current ? "Запрос отклонён без записи. Можно начать новую попытку с новым выбором."
        : "Действие не записано. Можно начать новую попытку с новым выбором.");
    } else {
      setPhase("uncertain");
      setMessage(fresh.requiredChoicesConfirmed ? "Подтверждения проверены." : "Результат не позволяет повторить запись. Проверьте ещё раз.");
    }
    // Rotated release remounts the form: all choices and the old action key are discarded.
    onStatus(fresh);
  };
  const reconcile = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const fresh = await readStatus(undefined, actionKey.current ?? undefined);
      applyReadBack(fresh);
    } catch { if (active.current) setMessage("Не удалось проверить результат. Повторная запись не выполнялась."); }
    finally { busy.current = false; }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy.current || phase !== "idle") return;
    const data = new FormData(event.currentTarget);
    if (data.get("personalDataConsent") !== "on" || data.get("accountTermsAccepted") !== "on") return;
    busy.current = true;
    setPhase("saving"); setMessage("");
    try {
      actionKey.current = crypto.randomUUID();
      definitiveRejection.current = false;
      const response = await fetch("/v1/me/consents", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ storefront: "COURSES",
          releaseVersion: status.releaseVersion, manifestSha256: status.manifestSha256, actionKey: actionKey.current,
          expectedActionSequence: status.actionSequence,
          personalDataConsent: true, accountTermsAccepted: true, marketingConsent: data.get("marketingConsent") === "on" }) });
      if (!active.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        definitiveRejection.current = response.status >= 400 && response.status < 500 && Boolean(body?.code && noWriteErrors.has(body.code));
      }
      const fresh = await readStatus(undefined, actionKey.current);
      if (!active.current) return;
      applyReadBack(fresh);
    } catch {
      if (active.current) { setPhase("uncertain"); setMessage("Результат записи неизвестен. Проверьте результат; новый POST не требуется."); }
    } finally { busy.current = false; }
  };
  return <section className="accountSection"><h2>Подтверждения после входа</h2>
    <p>Подтвердите выбор в своём аккаунте. Отметки до проверки email не заменяют это действие.</p>
    <p><a href={docs.get("privacy")?.url} target="_blank" rel="noreferrer">Политика конфиденциальности</a></p>
    <form key={formEpoch} className="authForm" onSubmit={submit}>
      <fieldset disabled={!ready || phase !== "idle"}>
        <label className="check"><input required type="checkbox" name="personalDataConsent" />Согласен с <a href={docs.get("personal_data")?.url} target="_blank" rel="noreferrer">обработкой персональных данных</a></label>
        <label className="check"><input required type="checkbox" name="accountTermsAccepted" />Принимаю <a href={docs.get("account_terms")?.url} target="_blank" rel="noreferrer">условия аккаунта</a></label>
        <label className="check"><input type="checkbox" name="marketingConsent" />Хочу получать <a href={docs.get("marketing_consent")?.url} target="_blank" rel="noreferrer">рекламные письма Flexperiment</a> (необязательно)</label>
        <button type="submit">{phase === "saving" ? "Подтверждаем…" : "Подтвердить выбор"}</button>
      </fieldset>
    </form>
    {!ready && <p role="alert">Комплект документов не опубликован. Доступ остаётся закрытым.</p>}
    {phase === "uncertain" && <button type="button" onClick={() => { void reconcile(); }}>Проверить результат без повторной записи</button>}
    {phase === "retryable" && <button type="button" onClick={() => {
      if (busy.current) return;
      actionKey.current = null; definitiveRejection.current = false;
      setFormEpoch(value => value + 1); setPhase("idle"); setMessage("");
    }}>Начать новую попытку</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
