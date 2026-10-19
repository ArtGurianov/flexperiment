"use client";
import { useRef, useState, type FormEvent } from "react";
import { api, AdminApiError } from "../../lib/api";

/** A scanner may type/paste into this field; only an explicit operator submit admits a guest. */
export function LabCheckIn() {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const locked = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (locked.current) return;
    const form = event.currentTarget, data = new FormData(form);
    locked.current = true; setBusy(true); setMessage("");
    try {
      await api("/v2/lab/check-in", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurrenceRef: data.get("occurrenceRef"), qrToken: data.get("qrToken") }) });
      setMessage("Проход отмечен. Повторный проход по этому билету запрещён.");
      (form.elements.namedItem("qrToken") as HTMLInputElement).value = "";
    } catch (error) {
      setMessage(error instanceof AdminApiError && error.code === "LAB_QR_ALREADY_USED" ? "Билет уже использован. Не пропускайте повторно."
        : "Проход не подтверждён. Проверьте встречу, QR и состояние билета.");
    } finally { locked.current = false; setBusy(false); }
  };
  return <section aria-labelledby="lab-check-in"><h2 id="lab-check-in">Вход по билету LAB</h2><p>Проверка необратима. Сверьте встречу перед подтверждением.</p>
    <form onSubmit={submit}><label>Идентификатор встречи<input name="occurrenceRef" required maxLength={128} /></label>
      <label>QR билета<input name="qrToken" required minLength={43} maxLength={43} autoComplete="off" /></label>
      <button disabled={busy}>{busy ? "Проверяем…" : "Подтвердить проход"}</button></form>{message && <p role="status">{message}</p>}
  </section>;
}
