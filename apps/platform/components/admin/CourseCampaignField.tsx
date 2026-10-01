"use client";

import { useFormFields } from "@payloadcms/ui";
import { useEffect, useRef, useState } from "react";

type Stage = "draft" | "queued" | "completed" | "failed";
type PreviewLesson = { lessonRef: string; title: string; slug: string };

export function CourseCampaignField() {
  const courseRef = useFormFields(([fields]) => fields.courseRef?.value);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [previewLessons, setPreviewLessons] = useState<PreviewLesson[]>([]);
  const [stage, setStage] = useState<Stage>("draft");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const createIdempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    if (!campaignId || stage !== "queued") return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/courses/campaigns/${encodeURIComponent(String(courseRef))}/${encodeURIComponent(campaignId)}/status`, {
          cache: "no-store",
        });
        const body = await response.json() as {
          state?: string;
          counts?: { pending?: number; sent?: number; skipped?: number; failed?: number };
          code?: string;
        };
        if (!response.ok) throw new Error(body.code || "CAMPAIGN_STATUS_FAILED");
        if (cancelled) return;
        if (body.state === "COMPLETED") {
          setStage("completed");
          setStatus(`Рассылка завершена: отправлено ${body.counts?.sent ?? 0}, пропущено ${body.counts?.skipped ?? 0}.`);
        } else if (body.state === "FAILED") {
          setStage("failed");
          setStatus(`Рассылка остановлена: ошибок ${body.counts?.failed ?? 0}. Повтор использует те же ключи идемпотентности.`);
        } else {
          setStatus(`Рассылка в очереди: ожидают ${body.counts?.pending ?? 0}, отправлено ${body.counts?.sent ?? 0}.`);
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Статус рассылки недоступен.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [campaignId, courseRef, stage]);

  const command = async (action: "create" | "confirm" | "retry") => {
    if (typeof courseRef !== "string" || !courseRef) { setStatus("Сначала сохраните courseRef."); return; }
    setBusy(true); setStatus("");
    try {
      const path = action === "create" ? `/api/courses/campaigns/${encodeURIComponent(courseRef)}`
        : `/api/courses/campaigns/${encodeURIComponent(courseRef)}/${encodeURIComponent(campaignId!)}/${action}`;
      if (action === "create" && !createIdempotencyKey.current) createIdempotencyKey.current = crypto.randomUUID();
      const response = await fetch(path, {
        method: "POST", headers: {
          "content-type": "application/json",
          ...(action === "create" ? { "idempotency-key": createIdempotencyKey.current! } : {}),
        },
        body: JSON.stringify(action === "create" ? { subject, message } : {}),
      });
      const body = await response.json() as {
        id?: string;
        preview?: { lessons?: PreviewLesson[] };
        recipients?: number;
        eligibleRecipients?: number;
        state?: string;
        retriedRecipients?: number;
        code?: string;
      };
      if (!response.ok) throw new Error(body.code || "CAMPAIGN_COMMAND_FAILED");
      if (action === "create") { setCampaignId(body.id!); setPreviewLessons(body.preview?.lessons ?? []); setStage("draft"); setStatus("Предпросмотр создан. Публикация курса ничего не отправляет."); }
      if (action === "confirm") { setStage("queued"); setStatus(`Рассылка поставлена в очередь. Получатели: ${body.recipients ?? 0}; сейчас подходят по согласию: ${body.eligibleRecipients ?? 0}. Перед каждым письмом согласие проверяется снова.`); }
      if (action === "retry") { setStage("queued"); setStatus(`Повторно поставлено в очередь: ${body.retriedRecipients ?? 0}.`); }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Команда не выполнена.");
    } finally { setBusy(false); }
  };

  return <section style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}>
    <strong>Письмо ученикам курса</strong><p>Отправка отделена от публикации и требует отдельного подтверждения.</p>
    <label style={{ display: "grid", gap: 6, marginBottom: 10 }}>Тема<input disabled={Boolean(campaignId)} value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
    <label style={{ display: "grid", gap: 6, marginBottom: 10 }}>Сообщение<textarea disabled={Boolean(campaignId)} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    {previewLessons.length > 0 ? <div><strong>Новые опубликованные уроки</strong><ul>{previewLessons.map((lesson) => <li key={lesson.lessonRef}>{lesson.title}</li>)}</ul></div> : null}
    {!campaignId && <button disabled={busy || !subject.trim() || !message.trim()} type="button" onClick={() => void command("create")}>Создать черновик</button>}
    {campaignId && stage === "draft" && <button disabled={busy} type="button" onClick={() => void command("confirm")}>Подтвердить и поставить в очередь</button>}
    {campaignId && stage === "failed" && <button disabled={busy} type="button" onClick={() => void command("retry")}>Повторить ошибки</button>}
    {status && <p role="status">{status}</p>}
  </section>;
}
