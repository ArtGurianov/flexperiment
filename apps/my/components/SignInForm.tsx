"use client";

import { validMyReturnTarget } from "@/lib/return-targets";
import { useEffect, useState, type FormEvent } from "react";

/** FLEX-120 sign-in on my: e-mail → code. All calls are same-origin `/v1/my/*`; the browser never
 * sees a session token (only the host-only cookie). No analytics, no logging of input. */
type LegalDocument = { kind: string; version: string; sha256: string; url: string };
type LegalRelease = { version: string; manifestSha256: string; manifest: { documents: LegalDocument[] } };
declare global {
  interface Window {
    smartCaptcha?: { render: (container: HTMLElement, input: { sitekey: string; hl: "ru"; callback: (token: string) => void }) => number;
      destroy: (id: number) => void; reset: (id: number) => void };
  }
}

const MESSAGES: Record<string, string> = {
  OTP_INVALID_OR_EXPIRED: "Код неверный или устарел. Запросите новый код.",
  TOO_MANY_ATTEMPTS: "Слишком много попыток. Запросите новый код.",
  RATE_LIMITED: "Слишком много запросов. Подождите минуту и попробуйте снова.",
  SMARTCAPTCHA_REJECTED: "Подтвердите, что вы не робот, и повторите.",
  LEGAL_RELEASE_NOT_FOUND: "Вход временно недоступен: правовые документы аккаунта ещё не опубликованы.",
  LEGAL_RELEASE_STALE: "Документы обновились. Обновите страницу и подтвердите их снова.",
  PERSONAL_DATA_CONSENT_REQUIRED: "Нужно согласие на обработку персональных данных.",
  ACCOUNT_TERMS_ACCEPTANCE_REQUIRED: "Нужно принять условия аккаунта.",
  EMAIL_INVALID: "Проверьте адрес почты.",
  CONSENT_STATE_STALE: "Согласия изменились в другой вкладке. Обновите страницу.",
  CONSENT_WRITE_UNCONFIRMED: "Не удалось подтвердить согласия. Повторите вход.",
};
const message = (code: string) => MESSAGES[code] ?? "Не удалось выполнить запрос. Попробуйте ещё раз.";

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: response.ok, payload };
}

export default function SignInForm({ next, captchaSiteKey, onlyConsent = false }: { next: string; captchaSiteKey?: string; onlyConsent?: boolean }) {
  const [release, setRelease] = useState<LegalRelease | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [personalData, setPersonalData] = useState(false);
  const [accountTerms, setAccountTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendAfter, setResendAfter] = useState(0);

  useEffect(() => {
    void fetch("/v1/my/legal", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as LegalRelease : null)
      .then(setRelease).catch(() => setRelease(null));
  }, []);

  useEffect(() => {
    if (!captchaSiteKey) return;
    let widget: number | undefined;
    const render = () => {
      const container = document.getElementById("my-smartcaptcha");
      if (container && window.smartCaptcha) widget = window.smartCaptcha.render(container, { sitekey: captchaSiteKey, hl: "ru", callback: setCaptchaToken });
    };
    if (window.smartCaptcha) render();
    else {
      const script = document.createElement("script");
      script.src = "https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload";
      script.async = true; script.onload = render;
      document.head.append(script);
    }
    return () => { if (widget !== undefined) window.smartCaptcha?.destroy(widget); };
  }, [captchaSiteKey]);

  useEffect(() => {
    if (resendAfter <= 0) return;
    const timer = window.setTimeout(() => setResendAfter((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendAfter]);

  const documents = new Map(release?.manifest.documents.map((document) => [document.kind, document]));
  const personalDataDoc = documents.get("personal_data");
  const accountTermsDoc = documents.get("account_terms");
  const marketingDoc = documents.get("marketing_consent");

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    if (!personalDataDoc || !accountTermsDoc || !marketingDoc) { setError(message("LEGAL_RELEASE_NOT_FOUND")); return; }
    setBusy(true); setError("");
    const { ok, payload } = await post("/v1/my/otp/send", {
      email, captchaToken, personalDataConsent: personalData, accountTermsAccepted: accountTerms, marketingConsent: marketing,
      personalDataVersion: personalDataDoc.version, personalDataSha256: personalDataDoc.sha256,
      accountTermsVersion: accountTermsDoc.version, accountTermsSha256: accountTermsDoc.sha256,
      marketingDocumentVersion: marketingDoc.version, marketingDocumentSha256: marketingDoc.sha256,
    }).catch(() => ({ ok: false, payload: {} as Record<string, unknown> }));
    setBusy(false);
    if (!ok) { setError(message(String(payload.code ?? ""))); return; }
    setStep("code"); setCode("");
    setResendAfter(Number(payload.resendAfterSeconds) || 60);
  }

  async function recordConsents(): Promise<string> {
    const status = await fetch("/v1/my/consents", { credentials: "same-origin", cache: "no-store" });
    if (!status.ok) return "CONSENT_WRITE_UNCONFIRMED";
    const { actionSequence } = await status.json() as { actionSequence: number };
    const key = new Uint8Array(24); crypto.getRandomValues(key);
    const actionKey = btoa(String.fromCharCode(...key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const { ok, payload } = await post("/v1/my/consents", {
      releaseVersion: release!.version, manifestSha256: release!.manifestSha256, actionKey, expectedActionSequence: actionSequence,
      personalDataConsent: personalData, accountTermsAccepted: accountTerms, marketingConsent: marketing,
    });
    return ok ? "OK" : String(payload.code ?? "CONSENT_WRITE_UNCONFIRMED");
  }

  async function renewConsents(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const recorded = await recordConsents().catch(() => "CONSENT_WRITE_UNCONFIRMED");
    if (recorded === "OK") { window.location.assign(next); return; }
    setError(message(recorded)); setBusy(false);
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    const { ok, payload } = await post("/v1/my/otp/verify", { email, otp: code, next })
      .catch(() => ({ ok: false, payload: {} as Record<string, unknown> }));
    if (!ok) { setError(message(String(payload.code ?? ""))); setBusy(false); return; }
    // Record the user's actual, separate choices as an authenticated consent action against the
    // exact edition shown in this form (Commerce refuses a stale edition) before leaving.
    const recorded = await recordConsents().catch(() => "CONSENT_WRITE_UNCONFIRMED");
    if (recorded !== "OK") { setError(message(recorded)); setBusy(false); return; }
    // `next` is re-validated by Commerce; only a local my path comes back.
    window.location.assign(validMyReturnTarget(payload.next));
  }

  if (release === undefined) return <p>Загрузка…</p>;
  if (release === null) return <p role="alert">{message("LEGAL_RELEASE_NOT_FOUND")}</p>;

  if (step === "code") return (
    <form onSubmit={verify} noValidate>
      <p>Мы отправили код на {email}, если вход для этого адреса возможен. Код действует 10 минут.</p>
      <label>Код из письма
        <input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
          value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || code.length !== 6}>Войти</button>
      <button type="button" disabled={busy || resendAfter > 0} onClick={() => void requestCode()}>
        {resendAfter > 0 ? `Отправить код ещё раз через ${resendAfter} с` : "Отправить код ещё раз"}
      </button>
      <button type="button" onClick={() => { setStep("email"); setError(""); }}>Изменить адрес</button>
    </form>
  );

  return (
    <form onSubmit={onlyConsent ? renewConsents : requestCode} noValidate>
      {!onlyConsent && <><p>Если аккаунта с этим адресом ещё нет, он будет создан. Один аккаунт для курсов и LAB.</p>
      <label>Почта
        <input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label></>}
      <label>
        <input type="checkbox" checked={personalData} onChange={(event) => setPersonalData(event.target.checked)} />
        Согласен на <a href={personalDataDoc?.url} target="_blank" rel="noreferrer">обработку персональных данных</a>
      </label>
      <label>
        <input type="checkbox" checked={accountTerms} onChange={(event) => setAccountTerms(event.target.checked)} />
        Принимаю <a href={accountTermsDoc?.url} target="_blank" rel="noreferrer">условия аккаунта</a>
      </label>
      <label>
        <input type="checkbox" checked={marketing} onChange={(event) => setMarketing(event.target.checked)} />
        Хочу получать новости (<a href={marketingDoc?.url} target="_blank" rel="noreferrer">по желанию</a>)
      </label>
      {captchaSiteKey && <div id="my-smartcaptcha" />}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy || !personalData || !accountTerms || (!onlyConsent && (!email || (!!captchaSiteKey && !captchaToken)))}>{onlyConsent ? "Подтвердить и продолжить" : "Получить код"}</button>
      {onlyConsent && <a href={`/sign-in?next=${encodeURIComponent(next)}`}>Войти заново</a>}
    </form>
  );
}
