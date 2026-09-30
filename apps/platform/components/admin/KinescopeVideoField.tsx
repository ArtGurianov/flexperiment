"use client";

import { useField, useFormFields } from "@payloadcms/ui";
import { useEffect, useRef, useState } from "react";
import { Upload } from "tus-js-client";

type UploadState = "idle" | "initializing" | "uploading" | "processing" | "ready" | "failed";

export function KinescopeVideoField() {
  const lessonRef = useFormFields(([fields]) => fields.lessonRef?.value);
  const title = useFormFields(([fields]) => fields.title?.value);
  const { setValue } = useField<number | null>({ path: "durationSeconds" });
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const active = useRef<Upload | null>(null);
  const pollGeneration = useRef(0);

  useEffect(() => () => {
    pollGeneration.current += 1;
    void active.current?.abort();
  }, []);

  const poll = async (uploadSessionId: string, generation: number) => {
    while (pollGeneration.current === generation) {
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
      if (pollGeneration.current !== generation) return;
      const response = await fetch(`/api/lessons/video-upload/${encodeURIComponent(uploadSessionId)}`, { cache: "no-store" });
      const body = await response.json() as { state?: "UPLOADING" | "PROCESSING" | "READY" | "FAILED"; durationSeconds?: number | null; errorCode?: string | null };
      if (!response.ok) throw new Error("Не удалось проверить обработку видео.");
      if (body.state === "READY") { setValue(body.durationSeconds ?? null); setState("ready"); setMessage("Видео обработано и атомарно привязано к уроку."); return; }
      if (body.state === "FAILED") throw new Error(body.errorCode || "Обработка видео завершилась ошибкой. Старая привязка сохранена.");
      setState("processing");
      setMessage("Kinescope обрабатывает видео…");
    }
  };

  const choose = async (file: File) => {
    if (typeof lessonRef !== "string" || !lessonRef || typeof title !== "string" || !title) {
      setState("failed"); setMessage("Сначала сохраните lessonRef и название урока."); return;
    }
    pollGeneration.current += 1;
    const generation = pollGeneration.current;
    setState("initializing"); setMessage("Создаём закрытую сессию загрузки…"); setProgress(0);
    try {
      const response = await fetch("/api/lessons/video-upload", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonRef, title }),
      });
      const initialized = await response.json() as { uploadSessionId?: string; endpoint?: string; code?: string };
      if (!response.ok || !initialized.uploadSessionId || !initialized.endpoint) throw new Error(initialized.code || "Не удалось начать загрузку.");
      setState("uploading"); setMessage("Загружаем напрямую в Kinescope…");
      const upload = new Upload(file, {
        uploadUrl: initialized.endpoint,
        retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
        metadata: { filename: file.name, filetype: file.type },
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => setProgress(total > 0 ? Math.round((sent / total) * 100) : 0),
        onError: (error) => {
          active.current = null;
          if (pollGeneration.current === generation) { setState("failed"); setMessage(error.message); }
        },
        onSuccess: () => {
          active.current = null;
          if (pollGeneration.current !== generation) return;
          setState("processing"); setMessage("Загрузка завершена. Ждём обработки…");
          void poll(initialized.uploadSessionId!, generation).catch((error: unknown) => {
            if (pollGeneration.current !== generation) return;
            setState("failed");
            setMessage(error instanceof Error ? error.message : "Не удалось проверить обработку видео.");
          });
        },
      });
      active.current = upload;
      upload.start();
    } catch (error) {
      setState("failed"); setMessage(error instanceof Error ? error.message : "Загрузка не началась.");
    }
  };

  return <div style={{ border: "1px solid var(--theme-elevation-200)", borderRadius: 4, padding: 16, marginBottom: 20 }}><strong>Видео Kinescope</strong><p>Идентификатор видео хранится только в commerce и никогда не записывается в Payload.</p><input accept="video/*" disabled={state === "initializing" || state === "uploading" || state === "processing"} type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void choose(file); }} />{state !== "idle" && <p role="status">{message}{state === "uploading" ? ` ${progress}%` : ""}</p>}</div>;
}
