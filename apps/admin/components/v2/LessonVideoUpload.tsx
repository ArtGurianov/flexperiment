"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Upload } from "tus-js-client";
import { api, AdminApiError } from "../../lib/api";
import { Notice } from "../ui/Notice";

type Course = { courseRef: string; projection: { version: number; authoringSource: "LEGACY_MANIFEST" | "COMMERCE_EDITORIAL" } | null };
type PublishedLesson = { lesson_ref: string; title: string | null; section_ref: string };
type PublishedCourse = { lessons: PublishedLesson[] };
type UploadState = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
type LatestUpload = {
  upload: { uploadSessionId: string; state: UploadState; errorCode: string | null } | null;
  activeBinding: boolean;
  activeDurationSeconds: number | null;
};

const pending = (state: UploadState | undefined) => state === "UPLOADING" || state === "PROCESSING";

export function LessonVideoUpload({ courses }: { courses: Course[] }) {
  const client = useQueryClient();
  const [courseRef, setCourseRef] = useState("");
  const [lessonRef, setLessonRef] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const active = useRef<Upload | null>(null);
  const generation = useRef(0);

  useEffect(() => () => {
    generation.current += 1;
    void active.current?.abort();
  }, []);

  const published = useQuery({
    queryKey: ["control-room-v2", "published-course", courseRef],
    queryFn: () => api<PublishedCourse>(`/v2/courses/${encodeURIComponent(courseRef)}/published`),
    enabled: Boolean(courseRef),
  });
  const latest = useQuery({
    queryKey: ["control-room-v2", "lesson-video", lessonRef],
    queryFn: async () => {
      const path = `/v2/lessons/${encodeURIComponent(lessonRef)}/video-upload`;
      const current = await api<LatestUpload>(path);
      if (!current.upload || !pending(current.upload.state)) return current;
      await api(`/v2/video-uploads/${encodeURIComponent(current.upload.uploadSessionId)}`);
      return api<LatestUpload>(path);
    },
    enabled: Boolean(lessonRef),
    refetchInterval: (query) => pending((query.state.data as LatestUpload | undefined)?.upload?.state) ? 3_000 : false,
  });

  const choose = async (file: File) => {
    const lesson = published.data?.lessons.find((item) => item.lesson_ref === lessonRef);
    if (!lesson || !file.name || file.size <= 0) { setMessage("Выберите опубликованный урок и непустой видеофайл."); return; }
    generation.current += 1;
    const current = generation.current;
    setUploading(true);
    setProgress(0);
    setMessage("Создаём сессию загрузки…");
    try {
      const initialized = await api<{ uploadSessionId: string; endpoint: string }>("/v2/video-uploads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonRef, title: lesson.title || lessonRef, filename: file.name, filesize: file.size }),
      });
      if (generation.current !== current) return;
      await client.invalidateQueries({ queryKey: ["control-room-v2", "lesson-video", lessonRef] });
      setMessage("Передаём файл в Kinescope…");
      const upload = new Upload(file, {
        uploadUrl: initialized.endpoint,
        retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
        metadata: { filename: file.name, filetype: file.type },
        removeFingerprintOnSuccess: true,
        onProgress: (sent, total) => { if (generation.current === current) setProgress(total ? Math.round(100 * sent / total) : 0); },
        onError: () => {
          active.current = null;
          if (generation.current === current) { setUploading(false); setMessage("Передача не завершилась. Повторите загрузку."); }
        },
        onSuccess: () => {
          active.current = null;
          if (generation.current === current) {
            setUploading(false);
            setMessage("Файл передан. Kinescope обрабатывает видео…");
            void client.invalidateQueries({ queryKey: ["control-room-v2", "lesson-video", lessonRef] });
          }
        },
      });
      active.current = upload;
      upload.start();
    } catch (error) {
      if (generation.current === current) {
        setUploading(false);
        setMessage(error instanceof AdminApiError ? error.code : "VIDEO_UPLOAD_INIT_FAILED");
      }
    }
  };

  const saved = latest.data;
  const busy = uploading || !saved || Boolean(latest.error);
  return <div className="catalogue-editor">
    <p>Загрузка привязывает видео к опубликованному уроку после обработки. До этого прежнее видео остаётся активным.</p>
    <label>Курс<select value={courseRef} onChange={(event) => {
      generation.current += 1;
      void active.current?.abort();
      active.current = null;
      setUploading(false);
      setCourseRef(event.target.value);
      setLessonRef("");
      setMessage("");
    }}><option value="">Выберите курс</option>{courses.filter((item) => item.projection?.authoringSource === "COMMERCE_EDITORIAL").map((item) =>
      <option key={item.courseRef} value={item.courseRef}>{item.courseRef}</option>)}</select></label>
    {published.error ? <Notice error={published.error instanceof AdminApiError ? published.error.code : "PUBLISHED_COURSE_UNAVAILABLE"} /> : null}
    {published.data ? <label>Урок<select value={lessonRef} onChange={(event) => {
      generation.current += 1;
      void active.current?.abort();
      active.current = null;
      setUploading(false);
      setLessonRef(event.target.value);
      setMessage("");
    }}><option value="">Выберите урок</option>{published.data.lessons.map((item) =>
      <option key={item.lesson_ref} value={item.lesson_ref}>{item.title || item.lesson_ref}</option>)}</select></label> : null}
    {latest.error ? <Notice error={latest.error instanceof AdminApiError ? latest.error.code : "VIDEO_STATUS_UNAVAILABLE"} /> : null}
    {lessonRef ? <>
      <p role="status">{uploading ? `Передаём файл: ${progress}%`
        : saved?.upload?.state === "READY" ? "Видео обработано и привязано к уроку."
        : saved?.upload?.state === "FAILED" ? `Обработка завершилась ошибкой${saved.upload.errorCode ? `: ${saved.upload.errorCode}` : ""}. Прежняя привязка сохранена.`
          : saved?.upload?.state === "PROCESSING" ? "Kinescope обрабатывает видео…"
            : saved?.upload?.state === "UPLOADING" ? message || "Загрузка ещё не завершена. Можно выбрать файл повторно."
              : message || (saved?.activeBinding ? "Видео привязано." : "Видео пока не привязано.")}</p>
      {saved?.activeBinding ? <small>Активная привязка · длительность {saved.activeDurationSeconds ?? "—"} с</small> : null}
      {pending(saved?.upload?.state) ? <small>Новая попытка отменит незавершённую сессию. Активное видео останется доступным до READY.</small> : null}
      <label>Видеофайл<input type="file" accept="video/*" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void choose(file);
        event.target.value = "";
      }} /></label>
    </> : null}
  </div>;
}
