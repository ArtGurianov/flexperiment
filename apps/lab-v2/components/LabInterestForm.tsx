"use client";

import { useId, useState } from "react";
import { commerceApiUrl } from "../../../lib/commerce-api";
import type { LabShowcase } from "../../../lib/lab-showcase-contract";

/**
 * FLEX-8 pre-registration: records interest in one "sales are open" email. It never reserves a seat
 * or starts a purchase. The consent checkbox is separate, unticked and not combined with anything.
 */
export default function LabInterestForm({ interest, cities }: { interest: LabShowcase["interest"]; cities: LabShowcase["cities"] }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [cityId, setCityId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const { consent, privacy } = interest;
  if (!interest.available || !consent || !privacy || !cities.length) return <p className="empty">Предзапись временно недоступна.</p>;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agreed || !cityId) return;
    setState("busy");
    try {
      const response = await fetch(commerceApiUrl("/v1/lab/interest"), {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, cityId, consent: { version: consent.version, textSha256: consent.textSha256 } }),
      });
      setState(response.status === 202 ? "sent" : "error");
    } catch { setState("error"); }
  };
  if (state === "sent") {
    return <p role="status">Заявка принята. Если письмо с подтверждением придёт, откройте ссылку в течение 48 часов.</p>;
  }
  return <form onSubmit={submit} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Сообщить о старте продаж</h3>
    <p>Предзапись не резервирует место и не является покупкой билета.</p>
    <label htmlFor={`${id}-email`}>Email</label>
    <input id={`${id}-email`} type="email" required maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
    <label htmlFor={`${id}-city`}>Город</label>
      <select id={`${id}-city`} value={cityId} required onChange={(e) => setCityId(e.target.value)}>
        <option value="">Выберите город</option>
        {cities.map((city) => <option key={city.cityId} value={city.cityId}>{city.title}</option>)}
      </select>
    <label className="consent"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
      <span style={{ whiteSpace: "pre-line" }}>{consent.text}</span></label>
    <details><summary>Политика обработки персональных данных</summary>
      <p style={{ whiteSpace: "pre-line" }}>{privacy}</p></details>
    {state === "error" ? <p role="alert">Не удалось отправить заявку. Повторите попытку позже.</p> : null}
    <button type="submit" disabled={!agreed || !cityId || state === "busy"}>{state === "busy" ? "Отправляем…" : "Оставить предзапись"}</button>
  </form>;
}
