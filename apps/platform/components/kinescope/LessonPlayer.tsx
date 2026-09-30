"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadIframeApi, type KinescopePlayerInstance } from "./iframeApi";

type PlaybackGrant = {
  mode: "open" | "protected";
  videoId: string;
  resumeAt: number;
  token?: string;
  expiresAt?: string;
};

let playerSequence = 0;

const resumePath = (lessonRef: string) => `/v1/lessons/${encodeURIComponent(lessonRef)}/resume`;

export default function LessonPlayer({ lessonRef, title }: { lessonRef: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<KinescopePlayerInstance | null>(null);
  const positionRef = useRef(0);
  const sequenceRef = useRef(0);
  const lastSavedAtRef = useRef(0);
  const [grant, setGrant] = useState<PlaybackGrant | null>(null);
  const [state, setState] = useState<"loading" | "signin" | "denied" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/v1/lessons/${encodeURIComponent(lessonRef)}/playback`, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) { setState("signin"); return; }
      if (!response.ok) { setState("denied"); return; }
      const next = await response.json() as PlaybackGrant;
      setGrant(next);
      positionRef.current = next.resumeAt;
      setState("ready");
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
    });
    return () => controller.abort();
  }, [lessonRef]);

  useEffect(() => {
    const host = hostRef.current;
    if (!grant || !host) return;
    let cancelled = false;
    let player: KinescopePlayerInstance | null = null;
    const mount = document.createElement("div");
    mount.id = `kinescope-lesson-${++playerSequence}`;
    mount.style.width = "100%";
    mount.style.height = "100%";
    host.replaceChildren(mount);

    const save = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 15_000) return;
      lastSavedAtRef.current = now;
      const current = player ? await player.getCurrentTime().catch(() => positionRef.current) : positionRef.current;
      positionRef.current = Math.max(0, Math.floor(current));
      sequenceRef.current += 1;
      await fetch(resumePath(lessonRef), {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seconds: positionRef.current, clientSeq: sequenceRef.current, clientTs: new Date().toISOString() }),
      }).catch(() => undefined);
    };

    void loadIframeApi().then((api) => api.create(mount.id, {
      url: `https://kinescope.io/embed/${encodeURIComponent(grant.videoId)}`,
      size: { width: "100%", height: "100%" },
      behavior: { playsInline: true, preload: "metadata", localStorage: false },
      ui: { controls: true, mainPlayButton: true },
    })).then(async (created) => {
      if (cancelled) { await created.destroy().catch(() => undefined); return; }
      player = created;
      playerRef.current = created;
      if (grant.resumeAt > 0) await created.seekTo(grant.resumeAt).catch(() => undefined);
      created.on(created.Events.TimeUpdate, () => { void save(false); });
      created.on(created.Events.Pause, () => { void save(true); });
      created.on(created.Events.Error, () => setState("error"));
      created.on(created.Events.Unsupported, () => setState("error"));
    }).catch(() => setState("error"));

    const pageHide = () => {
      sequenceRef.current += 1;
      const body = JSON.stringify({ seconds: positionRef.current, clientSeq: sequenceRef.current, clientTs: new Date().toISOString() });
      navigator.sendBeacon(resumePath(lessonRef), new Blob([body], { type: "application/json" }));
    };
    window.addEventListener("pagehide", pageHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", pageHide);
      void save(true);
      playerRef.current = null;
      void player?.destroy().catch(() => undefined);
      host.replaceChildren();
    };
  }, [grant, lessonRef]);

  if (state === "signin") return <div className="playerGate"><p>Войдите, чтобы открыть урок.</p><Link className="primary" href={`/account?next=${encodeURIComponent(window.location.pathname)}`}>Получить ссылку →</Link></div>;
  if (state === "denied") return <div className="playerGate"><p>Урок пока недоступен для вашего аккаунта.</p><Link href="/courses">Вернуться к курсам</Link></div>;
  if (state === "error") return <div className="playerGate"><p>Видео сейчас не загрузилось. Попробуйте обновить страницу.</p></div>;
  return <div className="lessonPlayer" aria-label={`Видео: ${title}`}><div ref={hostRef} className="lessonPlayerHost" />{state === "loading" && <p>Проверяем доступ…</p>}</div>;
}
