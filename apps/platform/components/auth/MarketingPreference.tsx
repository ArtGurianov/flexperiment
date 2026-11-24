"use client";

import { useEffect, useRef, useState } from "react";

import { LegalLinkDate } from "@/components/legal/LegalEffectiveDate";
import { useLegalEffectiveAt } from "@/components/legal/useLegalEffectiveAt";

type Status = { storefront: "COURSES"; verifiedAccount: boolean; requiredChoicesConfirmed: boolean;
  releaseVersion: string | null; manifestSha256: string | null; actionSequence: number;
  action?: { key: string; outcome: "COMMITTED" | "ABSENT" };
  choices?: { marketing_consent?: boolean };
  documents: Array<{ kind: string; url: string }> };

const path = "/v1/me/consents?storefront=COURSES";
const read = async (actionKey?: string) => {
  const response = await fetch(actionKey ? `${path}&actionKey=${encodeURIComponent(actionKey)}` : path,
    { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("CONSENT_STATUS_UNAVAILABLE");
  const status = await response.json() as Status;
  if (status.storefront !== "COURSES" || typeof status.choices?.marketing_consent !== "boolean"
    || !Number.isSafeInteger(status.actionSequence)) throw new Error("CONSENT_STATUS_INVALID");
  return status;
};

/**
 * G-05 / G-18: the account's own marketing choice for COURSES. A change is one marketing-only authenticated action
 * for the current release (`POST /v1/me/consents/marketing`): it records only this choice and never re-records the
 * required ones. Guarded by the action sequence and confirmed only by read-back. A one-click email unsubscribe
 * stays in force: this switch does not lift it.
 */
export default function MarketingPreference() {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<"idle" | "saving" | "uncertain">("idle");
  const [message, setMessage] = useState("");
  const actionKey = useRef<string | null>(null);
  const busy = useRef(false);
  useEffect(() => { void read().then(setStatus).catch(() => setStatus(null)); }, []);
  const marketingDocument = status?.documents.find(document => document.kind === "marketing_consent");
  const effectiveAt = useLegalEffectiveAt(Boolean(status?.requiredChoicesConfirmed && marketingDocument), status?.releaseVersion);
  if (!status?.requiredChoicesConfirmed) return null;
  const consentGranted = status.choices!.marketing_consent!;

  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const fresh = await read(actionKey.current ?? undefined);
      setStatus(fresh);
      if (fresh.action?.outcome === "ABSENT") { setPhase("idle"); setMessage("Изменение не записано. Можно попробовать ещё раз."); }
      else { setPhase("idle"); setMessage(fresh.choices!.marketing_consent ? "Согласие на рекламную рассылку сохранено." : "Согласие на рекламную рассылку отозвано."); }
      actionKey.current = null;
    } catch { setPhase("uncertain"); setMessage("Не удалось проверить результат. Повторная запись не выполнялась."); }
    finally { busy.current = false; }
  };
  const change = async () => {
    if (busy.current || phase !== "idle") return;
    busy.current = true; setPhase("saving"); setMessage("");
    actionKey.current = crypto.randomUUID();
    try {
      await fetch("/v1/me/consents/marketing", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ storefront: "COURSES",
          releaseVersion: status.releaseVersion, manifestSha256: status.manifestSha256, actionKey: actionKey.current,
          expectedActionSequence: status.actionSequence, marketingConsent: !consentGranted }) });
    } catch { /* the read-back below decides; an unknown outcome is never replayed */ }
    busy.current = false;
    await confirm();
  };
  return <section className="accountSection" aria-labelledby="marketing-preference">
    <h2 id="marketing-preference">Рекламная рассылка</h2>
    <p><a href={marketingDocument?.url} target="_blank" rel="noreferrer">Согласие на рекламную рассылку Flexperiment</a><LegalLinkDate effectiveAt={effectiveAt} /> {consentGranted ? "дано" : "отсутствует"}. Это необязательно и не влияет на доступ к курсам.</p>
    <button type="button" disabled={phase !== "idle"} onClick={() => { void change(); }}>
      {phase === "saving" ? "Сохраняем…" : consentGranted ? "Отозвать согласие на рассылку" : "Дать согласие на рассылку"}
    </button>
    {phase === "uncertain" && <button type="button" onClick={() => { void confirm(); }}>Проверить результат без повторной записи</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
