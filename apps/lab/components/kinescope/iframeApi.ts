"use client";

/**
 * The Kinescope iframe player API, loaded directly rather than through
 * `@kinescope/react-kinescope-player`.
 *
 * That wrapper started loading from its constructor — during render — and so
 * reached its own create path before the element it mounts into existed, then
 * latched a flag so nothing retried. A page with a second player, or any
 * cached load, ended up with no player at all and no error. It also waited for
 * a `load` event on a script tag that had usually already fired one.
 *
 * Both are impossible here by construction: the tag is created in exactly one
 * place, everything awaits the same memoised promise, and creation happens
 * from an effect.
 */

const SCRIPT_SRC = "https://player.kinescope.io/latest/iframe.player.js";
const SCRIPT_ID = "__kinescope_iframe_player_api";

export type KinescopePreload = boolean | "none" | "metadata" | "auto";

/** Only the members this app uses; the API surface is much larger. */
export type KinescopePlayerInstance = {
  Events: Record<string, string>;
  on: (event: string, handler: (payload: unknown) => void) => void;
  destroy: () => Promise<void>;
};

export type KinescopeCreateOptions = {
  url: string;
  size: { width: string; height: string };
  behavior: {
    autoPlay?: boolean;
    autoPause?: boolean;
    loop?: boolean;
    muted?: boolean;
    playsInline?: boolean;
    preload?: KinescopePreload;
    localStorage?: boolean;
  };
  ui: { controls?: boolean; mainPlayButton?: boolean };
};

export type KinescopeIframePlayerApi = {
  create: (
    elementId: string,
    options: KinescopeCreateOptions,
  ) => Promise<KinescopePlayerInstance>;
};

declare global {
  interface Window {
    Kinescope?: { IframePlayer?: KinescopeIframePlayerApi };
  }
}

export const embedUrl = (videoId: string) => `https://kinescope.io/embed/${videoId}`;

let pending: Promise<KinescopeIframePlayerApi> | null = null;

/**
 * Resolves with the API, loading the script at most once per document. Callers
 * never inspect the tag themselves: a tag that has already executed will not
 * fire `load` again, and sharing this promise is what makes that unreachable.
 */
export function loadIframeApi(): Promise<KinescopeIframePlayerApi> {
  const ready = window.Kinescope?.IframePlayer;
  if (ready) return Promise.resolve(ready);

  pending ??= new Promise<KinescopeIframePlayerApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = SCRIPT_SRC;
    script.addEventListener("load", () => {
      const api = window.Kinescope?.IframePlayer;
      if (api) resolve(api);
      else reject(new Error("Kinescope iframe API loaded without IframePlayer"));
    });
    script.addEventListener("error", () =>
      reject(new Error("Kinescope iframe API failed to load")),
    );
    document.head.append(script);
  }).catch((error: unknown) => {
    // A failed load must not poison every later attempt with a settled
    // rejection; the next caller gets a fresh script instead.
    pending = null;
    throw error;
  });

  return pending;
}
