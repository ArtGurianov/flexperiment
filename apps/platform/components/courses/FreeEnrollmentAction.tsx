"use client";

import { useEffect, useRef, useState } from "react";
import {
  navigation, enrollmentAccountPath, readEnrollmentStatus, refusalMessage, rememberEnrollmentIntent, requestEnrollment,
  type EnrollmentIntent, type FreeEnrollmentStatus,
} from "./freeEnrollment";

type View =
  | { kind: "loading" } | { kind: "guest" } | { kind: "status"; status: FreeEnrollmentStatus } | { kind: "unavailable" };

/**
 * Explicit «Записаться бесплатно» (FLEX-128). A guest's click is remembered for this browser and carried through
 * the magic-link login; a signed-in click enrolls at once. Nothing enrolls without this action.
 * `lessonSlug` keeps a chosen lesson; from the course card the server opens the first lesson.
 */
export default function FreeEnrollmentAction({ courseSlug, lessonSlug, accessModel, compact = false, onEnrolled }: {
  courseSlug: string; lessonSlug?: string; accessModel: "FREE" | "PAID"; compact?: boolean;
  /** Stay on the current page (lesson gate) instead of navigating to the returned lesson. */
  onEnrolled?: () => void;
}) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const intent: EnrollmentIntent = lessonSlug ? { courseSlug, lessonSlug } : { courseSlug };

  useEffect(() => {
    const controller = new AbortController();
    void readEnrollmentStatus(courseSlug, controller.signal).then(status => {
      if (controller.signal.aborted) return;
      setView(status === "signin" ? { kind: "guest" } : status ? { kind: "status", status } : { kind: "unavailable" });
    }).catch(() => { if (!controller.signal.aborted) setView({ kind: "unavailable" }); });
    return () => controller.abort();
  }, [courseSlug]);

  const toAccount = () => {
    rememberEnrollmentIntent(intent);
    navigation.assign(enrollmentAccountPath(intent));
  };
  const enroll = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage("");
    try {
      const outcome = await requestEnrollment(intent);
      if (outcome.kind === "enrolled") {
        if (onEnrolled) onEnrolled(); else navigation.assign(outcome.lessonPath);
        return;
      }
      if (outcome.kind === "signin" || outcome.kind === "consent") { toAccount(); return; }
      setMessage(outcome.kind === "refused" ? refusalMessage(outcome.code)
        : "Не удалось подтвердить запись. Повторное нажатие безопасно: запись не задвоится.");
    } finally { pending.current = false; setBusy(false); }
  };

  if (view.kind === "loading") return compact ? null : <p className="enrollmentStatus" role="status">Проверяем запись…</p>;
  if (view.kind === "unavailable") return null;
  if (view.kind === "guest") {
    if (accessModel !== "FREE") return null;
    return <div className="enrollmentAction">
      <button className="primary" type="button" onClick={toAccount}>Записаться бесплатно →</button>
      <p>Войдите по ссылке из письма — запись завершится автоматически и откроется {lessonSlug ? "этот урок" : "первый урок"}.</p>
    </div>;
  }
  const { status } = view;
  if (status.enrollment) {
    return <div className="enrollmentAction enrolled" aria-label="Запись на курс">
      <p><strong>Вы записаны</strong> · прогресс 0%{status.accessModel === "PAID" ? " · доступ сохранён после перехода курса на платный" : ""}</p>
      {!compact && <button type="button" disabled={busy} onClick={() => { void enroll(); }}>{busy ? "Открываем…" : "Продолжить обучение →"}</button>}
      {message && <p role="status">{message}</p>}
    </div>;
  }
  if (!status.enrollable) return null;
  return <div className="enrollmentAction">
    <button className="primary" type="button" disabled={busy} onClick={() => { void enroll(); }}>{busy ? "Записываем…" : "Записаться бесплатно →"}</button>
    <p>Бесплатно, без оплаты и заказа. Прогресс начнётся с 0%.</p>
    {message && <p role="status">{message}</p>}
  </div>;
}
