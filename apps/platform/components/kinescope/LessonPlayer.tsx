"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadIframeApi, type KinescopePlayerInstance } from "./iframeApi";
import LessonCompletion from "../courses/LessonCompletion";
import type { CourseCommercialSummary } from "@/lib/commerce-summary";
import CourseCheckout from "../checkout/CourseCheckout";
import FreeEnrollmentAction from "../courses/FreeEnrollmentAction";

/** FLEX-128: where the lesson sits, so a FREE course can offer the explicit enrollment in place. */
export type LessonEnrollmentContext = { courseSlug: string; lessonSlug: string; accessModel: "FREE" | "PAID" };

export type PlaybackGrant = {
  mode: "open" | "protected";
  videoId: string;
  resumeAt: number;
  token?: string;
  expiresAt?: string;
  learningCursor?: string;
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

const deniedDecision = async (response: Response) => [402, 403, 409].includes(response.status)
  ? await response.clone().json().catch(() => null) as { decision?: string; code?: string } | null : null;

function blockedState(denial: Awaited<ReturnType<typeof deniedDecision>>) {
  if (denial?.decision === "CONSENT_REQUIRED") return "consent";
  if (denial?.decision === "ENROLLMENT_REQUIRED") return "enroll";
  if (denial?.decision === "PURCHASE_REQUIRED") return "purchase";
  if (denial?.decision === "NOT_FOR_SALE") return "closed";
  if (denial?.code === "VIDEO_NOT_READY") return "video-not-ready";
  return "denied";
}

function LessonPlayerSession({ lessonRef, title, enrollment, commercial, offerDialog, myLogin, myCheckoutOrigin, showCompletion, onEnrolled }: {
  lessonRef: string; title: string; enrollment?: LessonEnrollmentContext; commercial?: CourseCommercialSummary; offerDialog?: boolean; myLogin?: string; myCheckoutOrigin?: string | null; showCompletion?: boolean; onEnrolled: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const shownOffer = useRef(false);
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
  const grantPath = playbackPath(lessonRef) + (showCompletion ? "?learning=1" : "");
  const [state, setState] = useState<"loading" | "signin" | "consent" | "enroll" | ReturnType<typeof blockedState> | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(grantPath, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (controller.signal.aborted) return;
      if (response.status === 401) { setState("signin"); return; }
      const denied = await deniedDecision(response);
      if (controller.signal.aborted) return;
      const next = await parseGrant(response);
      if (controller.signal.aborted) return;
      if (!next) { setState(blockedState(denied)); return; }
      setGrant(next);
      positionRef.current = next.resumeAt;
      setState("ready");
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
    });
    return () => controller.abort();
  }, [grantPath, setGrant]);

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
        const response = await fetch(grantPath, {
          method: "POST", cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (response.status === 401) { setState("signin"); setGrant(null); return; }
        const denied = await deniedDecision(response);
        const next = await parseGrant(response);
        if (controller.signal.aborted) return;
        if (!next) { setState(blockedState(denied)); setGrant(null); return; }
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
  }, [grant, grantPath, setGrant]);

  useEffect(() => {
    const host = hostRef.current;
    if (!grant || !host) return;
    const continuePlayback = continuePlaybackRef.current;
    continuePlaybackRef.current = false;
    let cancelled = false;
    let player: KinescopePlayerInstance | null = null;
    let playbackEvents = Promise.resolve();
    let phase: "PLAYING" | "ENDED" | undefined;
    const reportPlayback = (value: "PLAYING" | "ENDED") => {
      if (!grant.learningCursor || cancelled || phase === value || (value === "ENDED" && phase !== "PLAYING")) return;
      phase = value;
      playbackEvents = playbackEvents.then(async () => {
        await fetch(`/v1/lessons/${encodeURIComponent(lessonRef)}/learning-playback`, {
          method: "POST", cache: "no-store", credentials: "same-origin", keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cursor: grant.learningCursor, phase: value }),
        });
      }).catch(() => {});
    };
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
      created.on(created.Events.Playing, () => { if (!cancelled) { playingRef.current = true; reportPlayback("PLAYING"); } });
      created.on(created.Events.TimeUpdate, (event) => { if (!cancelled) void save(false, event.data?.currentTime); });
      const paused = () => { if (!cancelled) { playingRef.current = false; void save(true); } };
      created.on(created.Events.Pause, paused);
      created.on(created.Events.Ended, () => { paused(); reportPlayback("ENDED"); });
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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!offerDialog || state !== "purchase" || commercial?.saleMode !== "PUBLIC" || shownOffer.current || !dialog) return;
    const section = dialog.closest<HTMLElement>("[data-home-path]");
    const shell = section?.closest<HTMLElement>("main");
    if (!section || !shell) return;
    const start = performance.now();
    let frame = 0;
    let aligned = false;
    const check = () => {
      if (performance.now() - start > 1600) return;
      const atSection = !section.inert && Math.abs(section.getBoundingClientRect().top - shell.getBoundingClientRect().top) < 3;
      if (aligned && atSection) {
        shownOffer.current = true;
        dialog.showModal();
        return;
      }
      aligned = atSection;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [state, offerDialog, commercial?.saleMode]);

  if (state === "signin" && enrollment?.accessModel === "FREE") return <div className="playerGate"><p>Урок бесплатного курса откроется после записи.</p>
    <FreeEnrollmentAction courseSlug={enrollment.courseSlug} lessonSlug={enrollment.lessonSlug} accessModel="FREE" myLogin={myLogin} compact onEnrolled={onEnrolled} />
    {!myLogin && <Link href={`/account?next=${encodeURIComponent(window.location.pathname)}`}>Уже записаны? Войти</Link>}</div>;
  if (state === "signin") return <div className="playerGate"><p>Войдите, чтобы открыть урок.</p><Link className="primary" href={myLogin ?? `/account?next=${encodeURIComponent(window.location.pathname)}`}>{myLogin ? "Войти через MY →" : "Получить ссылку →"}</Link></div>;
  if (state === "enroll" && enrollment) return <div className="playerGate"><p>Чтобы открыть урок, запишитесь на бесплатный курс.</p>
    <FreeEnrollmentAction courseSlug={enrollment.courseSlug} lessonSlug={enrollment.lessonSlug} accessModel={enrollment.accessModel} myLogin={myLogin} compact onEnrolled={onEnrolled} /></div>;
  if (state === "enroll") return <div className="playerGate"><p>Чтобы открыть урок, запишитесь на бесплатный курс.</p><Link href="/courses">Вернуться к курсам</Link></div>;
  if (state === "consent") return <div className="playerGate"><p>Подтвердите обработку ПД и правила в аккаунте, чтобы открыть урок. Реклама необязательна.</p><Link href={myLogin ?? `/account?next=${encodeURIComponent(window.location.pathname)}`}>Подтвердить выбор</Link></div>;
  if (state === "purchase" && commercial?.saleMode !== "CLOSED" && commercial?.offerRef) {
    return <section aria-label="Покупка курса" className="playerGate">
      <p>Для просмотра нужен доступ ко всему курсу.</p>
      {offerDialog && <dialog ref={dialogRef} aria-label="Условия доступа к уроку">
        <p>Этот урок входит в платный курс.</p>
        <form method="dialog"><button type="submit">К условиям покупки</button></form>
      </dialog>}
      <CourseCheckout {...commercial} myOrigin={myCheckoutOrigin} lessonReturn={enrollment ? `/courses/${enrollment.courseSlug}/lessons/${enrollment.lessonSlug}` : undefined} />
    </section>;
  }
  if (state === "closed" || (state === "purchase" && commercial?.saleMode === "CLOSED")) {
    return <div className="playerGate"><p>Продажи курса закрыты.</p></div>;
  }
  if (state === "purchase") return <div className="playerGate"><p>Покупка курса временно недоступна.</p></div>;
  return <>
    {state === "denied" ? <div className="playerGate"><p>Урок пока недоступен для вашего аккаунта.</p><Link href="/courses">Вернуться к курсам</Link></div>
      : state === "video-not-ready" ? <div className="playerGate"><p>Видео пока недоступно.</p></div>
      : state === "error" ? <div className="playerGate"><p>Видео сейчас не загрузилось. Попробуйте обновить страницу.</p></div>
        : <div className="lessonPlayer" aria-label={`Видео: ${title}`}><div ref={hostRef} className="lessonPlayerHost" />
          {state === "loading" && <p>Проверяем доступ…</p>}</div>}
    {showCompletion && state !== "loading" && <LessonCompletion lessonRef={lessonRef} />}
  </>;
}

export default function LessonPlayer(props: { lessonRef: string; title: string; enrollment?: LessonEnrollmentContext; myLogin?: string; myCheckoutOrigin?: string | null; commercial?: CourseCommercialSummary; offerDialog?: boolean; showCompletion?: boolean }) {
  // A fresh enrollment re-requests the grant in a new session; the enrollment itself never mints one.
  const [attempt, setAttempt] = useState(0);
  return <LessonPlayerSession key={`${props.lessonRef}:${attempt}`} {...props} onEnrolled={() => setAttempt(value => value + 1)} />;
}
