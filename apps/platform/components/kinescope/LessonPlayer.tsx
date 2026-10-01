"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadIframeApi, type KinescopePlayerInstance } from "./iframeApi";

export type PlaybackGrant = {
  mode: "open" | "protected";
  videoId: string;
  resumeAt: number;
  token?: string;
  expiresAt?: string;
};

let playerSequence = 0;

const resumePath = (lessonRef: string) => `/v1/lessons/${encodeURIComponent(lessonRef)}/resume`;
const playbackPath = (lessonRef: string) => `/v1/lessons/${encodeURIComponent(lessonRef)}/playback`;

export const playbackEmbedUrl = (grant: PlaybackGrant) => {
  const url = new URL(`https://kinescope.io/embed/${encodeURIComponent(grant.videoId)}`);
  if (grant.mode === "protected") {
    if (!grant.token) throw new Error("PROTECTED_PLAYBACK_TOKEN_MISSING");
    url.searchParams.set("drmauthtoken", grant.token);
  }
  return url.toString();
};

const parseGrant = async (response: Response) => {
  if (!response.ok) return null;
  const grant = await response.json() as PlaybackGrant;
  if (!grant.videoId || !Number.isFinite(grant.resumeAt)) return null;
  if (grant.mode === "protected" && (!grant.token || !grant.expiresAt || !Number.isFinite(Date.parse(grant.expiresAt)))) return null;
  return grant;
};

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
    void fetch(playbackPath(lessonRef), {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) { setState("signin"); return; }
      const next = await parseGrant(response);
      if (!next) { setState("denied"); return; }
      setGrant(next);
      positionRef.current = next.resumeAt;
      setState("ready");
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
    });
    return () => controller.abort();
  }, [lessonRef]);

  useEffect(() => {
    if (grant?.mode !== "protected" || !grant.expiresAt) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const expiresAt = Date.parse(grant.expiresAt);
    const schedule = (delay: number) => { timer = window.setTimeout(() => { void refresh(); }, delay); };
    const refresh = async () => {
      try {
        const response = await fetch(playbackPath(lessonRef), {
          method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (response.status === 401) { setState("signin"); setGrant(null); return; }
        const next = await parseGrant(response);
        if (!next) { setState("denied"); setGrant(null); return; }
        setGrant(next);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const remaining = expiresAt - Date.now();
        if (remaining > 1_500) schedule(Math.min(5_000, remaining - 1_000));
        else { setState("error"); setGrant(null); }
      }
    };
    schedule(Math.max(1_000, expiresAt - Date.now() - 30_000));
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [grant, lessonRef]);

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

    const save = async (force = false, observedSeconds?: number) => {
      if (Number.isFinite(observedSeconds)) positionRef.current = Math.max(0, Math.floor(observedSeconds!));
      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 15_000) return;
      lastSavedAtRef.current = now;
      if (observedSeconds === undefined) {
        const current = player ? await player.getCurrentTime().catch(() => positionRef.current) : positionRef.current;
        positionRef.current = Math.max(0, Math.floor(current));
      }
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
      url: playbackEmbedUrl(grant),
      size: { width: "100%", height: "100%" },
      behavior: { playsInline: true, preload: "metadata", localStorage: false },
      ui: { controls: true, mainPlayButton: true },
    })).then(async (created) => {
      if (cancelled) { await created.destroy().catch(() => undefined); return; }
      player = created;
      playerRef.current = created;
      const resumeAt = Math.max(grant.resumeAt, positionRef.current);
      if (resumeAt > 0) await created.seekTo(resumeAt).catch(() => undefined);
      created.on(created.Events.TimeUpdate, (event) => { void save(false, event.data?.currentTime); });
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
