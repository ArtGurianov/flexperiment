"use client";

import { useFormFields } from "@payloadcms/ui";
import { useState } from "react";

type Stage = "draft" | "confirmed" | "sent";

export function CourseCampaignField() {
  const courseRef = useFormFields(([fields]) => fields.courseRef?.value);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("draft");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const command = async (action: "create" | "confirm" | "dispatch") => {
    if (typeof courseRef !== "string" || !courseRef) { setStatus("Сначала сохраните courseRef."); return; }
    setBusy(true); setStatus("");
    try {
      const path = action === "create" ? `/api/courses/campaigns/${encodeURIComponent(courseRef)}`
        : `/api/courses/campaigns/${encodeURIComponent(courseRef)}/${encodeURIComponent(campaignId!)}/${action}`;
      const response = await fetch(path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "create" ? { subject, message } : {}),
      });
      const body = await response.json() as { id?: string; recipients?: number; processed?: number; failed?: number; code?: string };
      if (!response.ok) throw new Error(body.code || "CAMPAIGN_COMMAND_FAILED");
      if (action === "create") { setCampaignId(body.id!); setStage("draft"); setStatus("Черновик создан. Публикация курса ничего не отправляет."); }
      if (action === "confirm") { setStage("confirmed"); setStatus(`Получатели зафиксированы: ${body.recipients ?? 0}. Перед отправкой согласия будут проверены снова.`); }
      if (action === "dispatch") { setStage("sent"); setStatus(`Обработано: ${body.processed ?? 0}; ошибок: ${body.failed ?? 0}.`); }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Команда не выполнена.");
    } finally { setBusy(false); }
  };

  return <section style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}>
    <strong>Письмо ученикам курса</strong><p>Отправка отделена от публикации и требует отдельного подтверждения.</p>
    <label style={{ display: "grid", gap: 6, marginBottom: 10 }}>Тема<input disabled={Boolean(campaignId)} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label style={{ display: "grid", gap: 6, marginBottom: 10 }}>Сообщение<textarea disabled={Boolean(campaignId)} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    {!campaignId && <button disabled={busy || !subject.trim() || !message.trim()} type="button" onClick={() => void command("create")}>Создать черновик</button>}
    {campaignId && stage === "draft" && <button disabled={busy} type="button" onClick={() => void command("confirm")}>Подтвердить получателей</button>}
    {campaignId && stage === "confirmed" && <button disabled={busy} type="button" onClick={() => void command("dispatch")}>Отправить подтверждённую рассылку</button>}
    {status && <p role="status">{status}</p>}
  </section>;
}
