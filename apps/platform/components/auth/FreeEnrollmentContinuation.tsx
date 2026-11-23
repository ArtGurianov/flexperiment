"use client";

import { useEffect, useRef, useState } from "react";
import {
  navigation, consumeEnrollmentIntent, readEnrollmentStatus, refusalMessage, requestEnrollment,
  type EnrollmentIntent, type FreeEnrollmentStatus,
} from "../courses/freeEnrollment";

/**
 * Completes the enrollment a visitor started before the magic-link login (FLEX-128). Rendered only for a
 * signed-in account behind the required-consent gate. It enrolls automatically only when THIS browser holds
 * the fresh mark of the visitor's own click; a bare `/account?enroll=…` link (another tab or a third party)
 * asks for one explicit confirmation instead. Then it opens the chosen lesson or the first lesson.
 */
export default function FreeEnrollmentContinuation({ intent }: { intent: EnrollmentIntent }) {
  const [status, setStatus] = useState<FreeEnrollmentStatus | null | "loading" | "error">("loading");
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [phase, setPhase] = useState<"idle" | "saving" | "done">("idle");
  const [message, setMessage] = useState("");
  const started = useRef(false);
  const autoChecked = useRef(false);

  const run = async () => {
    if (started.current) return;
    started.current = true; setPhase("saving"); setMessage("");
    const outcome = await requestEnrollment(intent);
    if (outcome.kind === "enrolled") { setPhase("done"); navigation.assign(outcome.lessonPath); return; }
    started.current = false; setPhase("idle");
    setMessage(outcome.kind === "refused" ? refusalMessage(outcome.code)
      : outcome.kind === "unknown" ? "Не удалось подтвердить запись. Повторное нажатие безопасно: запись не задвоится."
        : "Сессия или подтверждения изменились. Обновите страницу.");
  };

  useEffect(() => {
    const controller = new AbortController();
    void readEnrollmentStatus(intent.courseSlug, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const known = value === "signin" ? null : value;
      setStatus(known);
      if (autoChecked.current) return;
      autoChecked.current = true;
      // Consume the mark exactly once, even when the course can no longer be enrolled.
      const ownClick = consumeEnrollmentIntent(intent);
      if (known && (known.enrollment || known.enrollable) && ownClick) void run();
    }).catch(() => { if (!controller.signal.aborted) setStatus("error"); });
    return () => controller.abort();
    // `run` reads only the stable intent; re-running on its identity would re-consume the mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.courseSlug, intent.lessonSlug, statusAttempt]);

  if (status === "loading") return <p role="status">Проверяем запись на курс…</p>;
  if (status === "error") return <section className="accountSection">
    <p role="alert">Не удалось проверить запись на курс.</p>
    <button type="button" onClick={() => { setStatus("loading"); setStatusAttempt(attempt => attempt + 1); }}>Повторить проверку</button>
  </section>;
  if (!status) return <section className="accountSection"><p role="alert">Курс для записи не найден или недоступен.</p></section>;
  const title = status.courseTitle;
  if (phase !== "idle") return <section className="accountSection"><p role="status">{status.enrollment ? "Открываем урок…" : `Записываем на «${title}»…`}</p></section>;
  if (!status.enrollment && !status.enrollable) {
    return <section className="accountSection"><p role="alert">{refusalMessage(status.accessModel === "PAID" ? "FREE_COURSE_REQUIRED" : "COURSE_NOT_READY")}</p></section>;
  }
  return <section className="accountSection" aria-labelledby="free-enrollment-title">
    <h2 id="free-enrollment-title">{status.enrollment ? `Вы записаны на «${title}»` : `Записаться бесплатно на «${title}»`}</h2>
    <p>{status.enrollment ? "Прогресс 0%. Продолжите с выбранного урока." : "Бесплатно, без оплаты и заказа. Прогресс начнётся с 0%."}</p>
    <button className="primary" type="button" onClick={() => { void run(); }}>
      {status.enrollment ? "Открыть урок →" : "Записаться бесплатно →"}
    </button>
    {message && <p role="status">{message}</p>}
  </section>;
}
