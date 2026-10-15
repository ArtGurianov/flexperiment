"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
  if ((grant.mode !== "open" && grant.mode !== "protected") || !grant.videoId || !Number.isFinite(grant.resumeAt)) return null;
  if (grant.mode === "protected" && (
    !grant.token || !grant.expiresAt || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()
  )) return null;
  return grant;
};

function LessonPlayerSession({ lessonRef, title }: { lessonRef: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<KinescopePlayerInstance | null>(null);
  const positionRef = useRef(0);
  const playingRef = useRef(false);
  const continuePlaybackRef = useRef(false);
  const sequenceRef = useRef(0);
  const lastSavedAtRef = useRef(0);
  const [grant, commitGrant] = useState<PlaybackGrant | null>(null);
  const grantSnapshotRef = useRef<PlaybackGrant | null>(null);
  const setGrant = useCallback((next: PlaybackGrant | null) => {
    grantSnapshotRef.current = next;
    commitGrant(next);
  }, []);
  const [state, setState] = useState<"loading" | "signin" | "consent" | "denied" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(playbackPath(lessonRef), {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (controller.signal.aborted) return;
      if (response.status === 401) { setState("signin"); return; }
      if (response.status === 403 && (await response.clone().json()).decision === "CONSENT_REQUIRED") { setState("consent"); return; }
      const next = await parseGrant(response);
      if (controller.signal.aborted) return;
      if (!next) { setState("denied"); return; }
      setGrant(next);
      positionRef.current = next.resumeAt;
      setState("ready");
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
    });
    return () => controller.abort();
  }, [lessonRef, setGrant]);

  useEffect(() => {
    if (grant?.mode !== "protected" || !grant.expiresAt) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const expiresAt = Date.parse(grant.expiresAt);
    // A hung grant request never reaches catch. Expiry must close the old player even
    // when transport ignores cancellation or never settles at all.
    const expiryTimer = window.setTimeout(() => {
      if (grantSnapshotRef.current !== grant) return;
      controller.abort();
      setState("error");
      setGrant(null);
    }, Math.max(0, expiresAt - Date.now()));
    const schedule = (delay: number) => { timer = window.setTimeout(() => { void refresh(); }, delay); };
    const refresh = async () => {
      try {
        const response = await fetch(playbackPath(lessonRef), {
          method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) { setState("signin"); setGrant(null); return; }
        if (response.status === 403 && (await response.clone().json()).decision === "CONSENT_REQUIRED") { setState("consent"); setGrant(null); return; }
        const next = await parseGrant(response);
        if (controller.signal.aborted) return;
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
    return () => { controller.abort(); window.clearTimeout(expiryTimer); if (timer !== undefined) window.clearTimeout(timer); };
  }, [grant, lessonRef, setGrant]);

  useEffect(() => {
    const host = hostRef.current;
    if (!grant || !host) return;
    const continuePlayback = continuePlaybackRef.current;
    continuePlaybackRef.current = false;
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
        if (cancelled) return;
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
      created.on(created.Events.Playing, () => { if (!cancelled) playingRef.current = true; });
      created.on(created.Events.TimeUpdate, (event) => { if (!cancelled) void save(false, event.data?.currentTime); });
      const paused = () => { if (!cancelled) { playingRef.current = false; void save(true); } };
      created.on(created.Events.Pause, paused);
      created.on(created.Events.Ended, paused);
      created.on(created.Events.Error, () => { if (!cancelled) setState("error"); });
      created.on(created.Events.Unsupported, () => { if (!cancelled) setState("error"); });
      const resumeAt = Math.max(grant.resumeAt, positionRef.current);
      if (resumeAt > 0) await created.seekTo(resumeAt);
      if (!cancelled && continuePlayback) await created.play().catch(() => undefined);
    }).catch(() => { if (!cancelled) setState("error"); });

    const pageHide = () => {
      sequenceRef.current += 1;
      const body = JSON.stringify({ seconds: positionRef.current, clientSeq: sequenceRef.current, clientTs: new Date().toISOString() });
      navigator.sendBeacon(resumePath(lessonRef), new Blob([body], { type: "application/json" }));
    };
    window.addEventListener("pagehide", pageHide);
    return () => {
      const next = grantSnapshotRef.current;
      // Only a fresh authorized same-video grant may continue existing playback.
      // Denial, another video and another keyed lesson never inherit autoplay.
      continuePlaybackRef.current = playingRef.current && next !== null && next.videoId === grant.videoId && next.mode === grant.mode;
      playingRef.current = false;
      cancelled = true;
      window.removeEventListener("pagehide", pageHide);
      void save(true, positionRef.current);
      playerRef.current = null;
      void player?.destroy().catch(() => undefined);
      host.replaceChildren();
    };
  }, [grant, lessonRef]);

  if (state === "signin") return <div className="playerGate"><p>Войдите, чтобы открыть урок.</p><Link className="primary" href={`/account?next=${encodeURIComponent(window.location.pathname)}`}>Получить ссылку →</Link></div>;
  if (state === "consent") return <div className="playerGate"><p>Подтвердите обработку ПД и правила в аккаунте, чтобы открыть урок. Реклама необязательна.</p><Link href={`/account?next=${encodeURIComponent(window.location.pathname)}`}>Подтвердить выбор</Link></div>;
  if (state === "denied") return <div className="playerGate"><p>Урок пока недоступен для вашего аккаунта.</p><Link href="/courses">Вернуться к курсам</Link></div>;
  if (state === "error") return <div className="playerGate"><p>Видео сейчас не загрузилось. Попробуйте обновить страницу.</p></div>;
  return <div className="lessonPlayer" aria-label={`Видео: ${title}`}><div ref={hostRef} className="lessonPlayerHost" />{state === "loading" && <p>Проверяем доступ…</p>}</div>;
}

export default function LessonPlayer(props: { lessonRef: string; title: string }) {
  return <LessonPlayerSession key={props.lessonRef} {...props} />;
}
