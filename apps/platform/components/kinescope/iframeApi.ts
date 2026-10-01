"use client";

const SCRIPT_SRC = "https://player.kinescope.io/latest/iframe.player.js";
const SCRIPT_ID = "__kinescope_course_player_api";

export type KinescopePlayerInstance = {
  Events: Record<string, string>;
  on: (event: string, handler: (payload: KinescopePlayerEvent) => void) => void;
  getCurrentTime: () => Promise<number>;
  seekTo: (seconds: number) => Promise<void>;
  destroy: () => Promise<void>;
};

export type KinescopePlayerEvent = {
  data?: { currentTime?: number };
};

type KinescopeIframePlayerApi = {
  create: (elementId: string, options: {
    url: string;
    size: { width: string; height: string };
    behavior: { playsInline: boolean; preload: "metadata"; localStorage: false };
    ui: { controls: true; mainPlayButton: true };
  }) => Promise<KinescopePlayerInstance>;
};

declare global {
  interface Window { Kinescope?: { IframePlayer?: KinescopeIframePlayerApi } }
}

let pending: Promise<KinescopeIframePlayerApi> | null = null;

export function loadIframeApi(): Promise<KinescopeIframePlayerApi> {
  if (window.Kinescope?.IframePlayer) return Promise.resolve(window.Kinescope.IframePlayer);
  pending ??= new Promise<KinescopeIframePlayerApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) existing.remove();
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = SCRIPT_SRC;
    script.addEventListener("load", () => window.Kinescope?.IframePlayer
      ? resolve(window.Kinescope.IframePlayer)
      : reject(new Error("KINESCOPE_IFRAME_API_MISSING")));
    script.addEventListener("error", () => reject(new Error("KINESCOPE_IFRAME_API_LOAD_FAILED")));
    document.head.append(script);
  }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
