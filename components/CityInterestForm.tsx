"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import SmartCaptcha from "@/components/SmartCaptcha";
import { type CitySlug, requestableCities } from "@/lib/city-catalog";
import { commerceApiUrl } from "@/lib/commerce-api";

type Props = { scheduledCitySlugs: CitySlug[] };

export default function CityInterestForm({ scheduledCitySlugs }: Props) {
  const cities = useMemo(() => requestableCities(scheduledCitySlugs), [scheduledCitySlugs]);
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [consent, setConsent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!captchaToken || state === "submitting") return;
    setState("submitting");
    try {
      const response = await fetch(commerceApiUrl("/v1/public/city-interest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, city, pd_consent_accepted: consent, captcha_token: captchaToken }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("CITY_INTEREST_FAILED");
      setEmail(""); setCity(""); setConsent(false); setState("success"); setCaptchaResetKey((key) => key + 1);
    } catch {
      setState("error"); setCaptchaResetKey((key) => key + 1);
    }
  };

  return <section className="border border-bone/35 p-4 font-mono text-sm text-bone">
    <p className="leading-relaxed text-bone/75">Оставьте email и выберите город — сообщим, если запланируем там мастер-класс.</p>
    {!cities.length ? <p className="mt-4 border border-bone/50 p-3 text-bone/70" role="status">Сейчас мы не можем принять запрос для нового города. Пожалуйста, попробуйте позже.</p> : state === "success" ? <p className="mt-4 border border-acid/70 p-3" role="status">Запрос сохранён. Сообщим только о мастер-классе в выбранном городе.</p> : <form className="mt-4 grid gap-3" onSubmit={submit}>
      <label className="grid gap-1.5">Email
        <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid" />
      </label>
      <label className="grid gap-1.5">Желаемый город
        <select required value={city} onChange={(event) => setCity(event.target.value)} className="border border-bone/50 bg-ink px-3 py-2 text-bone focus:outline-2 focus:outline-acid">
          <option value="" disabled>Выберите город</option>
          {cities.map((entry) => <option key={entry.slug} value={entry.slug}>{entry.title}</option>)}
        </select>
      </label>
      <label className="flex items-start gap-2 text-xs leading-snug"><input required type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> <span>Подтверждаю согласие с <Link className="text-acid underline underline-offset-4" href="/legal/privacy-policy" target="_blank" rel="noopener noreferrer">политикой конфиденциальности</Link> и даю <Link className="text-acid underline underline-offset-4" href="/legal/personal-data-consent" target="_blank" rel="noopener noreferrer">согласие на обработку персональных данных</Link> для уведомления о мастер-классе в выбранном городе.</span></label>
      <SmartCaptcha onToken={setCaptchaToken} resetKey={captchaResetKey} />
      <button disabled={!captchaToken || state === "submitting"} className="border border-acid px-3 py-2 font-display text-acid disabled:cursor-not-allowed disabled:opacity-60">{state === "submitting" ? "Сохраняем…" : "Сообщить о мастер-классе"}</button>
      {state === "error" && <p role="status" className="text-bone/75">Не удалось сохранить запрос. Пройдите проверку ещё раз и повторите попытку.</p>}
    </form>}
  </section>;
}
