"use client";

import { useEffect, useRef, useState } from "react";

type Progress = { firstCompletedAt: string | null; progressPercent: number };

export default function LessonCompletion({ lessonRef }: { lessonRef: string }) {
  const path = `/v1/lessons/${encodeURIComponent(lessonRef)}/completion`;
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      mutation.current?.abort();
      mutation.current = null;
      setBusy(false);
      setFailed(false);
      setProgress(null);
      const controller = new AbortController();
      request = controller;
      void fetch(path, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
        .then(async response => {
          if (!response.ok) return;
          const result = await response.json() as Progress;
          if (!controller.signal.aborted) setProgress(result);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      request?.abort();
      mutation.current?.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [path]);

  const complete = async () => {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(path, { method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) { setProgress(null); return; }
      if (!response.ok) throw new Error("LESSON_COMPLETION_UNAVAILABLE");
      const result = await response.json() as Progress;
      if (!controller.signal.aborted) setProgress(result);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (mutation.current === controller) {
        mutation.current = null;
        setBusy(false);
      }
    }
  };

  if (!progress) return null;
  return <section className="lessonDescription" aria-label="Прогресс урока">
    {progress.firstCompletedAt ? <p role="status">Пройдено</p>
      : <button className="primary" type="button" disabled={busy} onClick={() => void complete()}>Отметить пройденным</button>}
    <p>Прогресс курса {progress.progressPercent}%</p>
    {failed && <p role="status">Не удалось сохранить отметку. Попробуйте ещё раз.</p>}
  </section>;
}
