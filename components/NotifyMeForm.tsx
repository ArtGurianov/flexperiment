"use client";

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import SmartCaptcha from "@/components/SmartCaptcha";
import { commerceApiUrl } from "@/lib/commerce-api";

type BaseBody = { email: string; pd_consent_accepted: true; captcha_token: string };
type Props = { endpoint: string; intro: string; submitLabel: string; successText: string; consentPurpose: string; buildBody: (base: BaseBody) => unknown; children?: ReactNode; onConflict?: (code: string) => void };

export default function NotifyMeForm({ endpoint, intro, submitLabel, successText, consentPurpose, buildBody, children, onConflict }: Props) {
  const [email, setEmail] = useState(""); const [consent, setConsent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null); const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!captchaToken || !consent || state === "submitting") return;
    setState("submitting");
    try {
      const response = await fetch(commerceApiUrl(endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(buildBody({ email, pd_consent_accepted: true, captcha_token: captchaToken })) });
      const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
      if (!response.ok) { const code = body?.error?.code ?? "NOTIFICATION_FAILED"; if (onConflict && code === "OCCURRENCE_ALREADY_AVAILABLE") { onConflict(code); setState("idle"); return; } throw new Error(code); }
      setEmail(""); setConsent(false); setState("success");
    } catch { setState("error"); }
    finally { setCaptchaResetKey((key) => key + 1); }
  };
  return <section className="border border-bone/35 p-4 font-mono text-sm text-bone"><p className="leading-relaxed text-bone/75">{intro}</p>
    {state === "success" ? <p className="mt-4 border border-acid/70 p-3" role="status">{successText}</p> : <form className="mt-4 grid gap-3" onSubmit={submit}>
      <label className="grid gap-1.5">Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" /></label>{children}
      <label className="flex items-start gap-2 text-xs leading-snug"><input required type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> <span>Подтверждаю согласие с <Link className="text-acid underline underline-offset-4" href="/legal/privacy-policy" target="_blank" rel="noopener noreferrer">политикой конфиденциальности</Link> и даю <Link className="text-acid underline underline-offset-4" href="/legal/personal-data-consent" target="_blank" rel="noopener noreferrer">согласие на обработку персональных данных</Link> {consentPurpose}</span></label>
      <SmartCaptcha onToken={setCaptchaToken} resetKey={captchaResetKey} /><button disabled={!captchaToken || !consent || state === "submitting"} className="border border-acid px-3 py-2 font-display text-acid disabled:cursor-not-allowed disabled:opacity-60">{state === "submitting" ? "Сохраняем…" : submitLabel}</button>
      {state === "error" && <p role="status" className="text-bone/75">Не удалось сохранить запрос. Пройдите проверку ещё раз и повторите попытку.</p>}</form>}
  </section>;
}
