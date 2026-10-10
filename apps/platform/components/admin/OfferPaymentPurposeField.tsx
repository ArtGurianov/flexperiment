"use client";

import { useFormFields } from "@payloadcms/ui";
import { useEffect, useId, useState } from "react";

type Purpose = { paymentPurpose: string | null; version: number; offerRef: string; courseRef: string };

export function OfferPaymentPurposeField() {
  const fieldRef = useFormFields(([fields]) => fields.courseRef?.value);
  const courseRef = typeof fieldRef === "string" && fieldRef ? fieldRef : null;
  const id = useId();
  const [current, setCurrent] = useState<Purpose | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const hasCurrent = current?.courseRef === courseRef;
  useEffect(() => {
    if (!courseRef) return;
    const controller = new AbortController();
    void fetch(`/api/courses/payment-purpose/${encodeURIComponent(courseRef)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Сначала настройте offer в Control Room; при недоступности commerce редактирование запрещено.");
        const body = await response.json() as Purpose;
        if (!controller.signal.aborted) { setCurrent({ ...body, courseRef }); setText(body.paymentPurpose ?? ""); setStatus(""); }
      }).catch(error => { if (!controller.signal.aborted) { setCurrent(null); setStatus(error.message); } });
    return () => controller.abort();
  }, [courseRef]);
  const save = async () => {
    if (!courseRef || !current || !hasCurrent) return;
    setBusy(true); setStatus("");
    try {
      const response = await fetch(`/api/courses/payment-purpose/${encodeURIComponent(courseRef)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentPurpose: text, expectedVersion: current.version }),
      });
      const body = await response.json() as { paymentPurpose?: string; version?: number; code?: string };
      if (!response.ok) throw new Error(body.code === "CATALOG_VERSION_CONFLICT"
        ? "Offer изменился. Перезагрузите страницу перед сохранением." : "Назначение не сохранено: проверьте текст и доступность commerce.");
      setCurrent({ ...current, paymentPurpose: body.paymentPurpose!, version: body.version! });
      setStatus("Сохранено в offer. Существующие заказы не изменены.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Сохранение не подтверждено."); }
    finally { setBusy(false); }
  };
  return <section style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}>
    <label htmlFor={id}><strong>Назначение платежа · offer</strong></label>
    <p>Отдельно от названий позиций чека. Копируется в заказ без сокращения.</p>
    {courseRef ? <><textarea id={id} value={hasCurrent ? text : ""} maxLength={512} disabled={!hasCurrent || busy}
      onChange={event => setText(event.target.value)} style={{ width: "100%", minHeight: 88 }} />
    <small>{text.length}/512 UTF-16 units · лимит Точки 140</small>
    <p><button type="button" disabled={!hasCurrent || busy || !text || text === current?.paymentPurpose} onClick={() => void save()}>
      {busy ? "Сохраняем…" : "Сохранить назначение"}</button></p></> : <p>Сначала сохраните курс.</p>}
    <p role="status" aria-live="polite">{status}</p>
  </section>;
}
