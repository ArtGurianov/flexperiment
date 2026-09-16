"use client";

import { useEffect, useRef } from "react";

import {
  embedUrl,
  loadIframeApi,
  type KinescopePlayerInstance,
  type KinescopePreload,
} from "./iframeApi";

export type KinescopePlayerProps = {
  videoId: string;
  className?: string;
  autoPlay?: boolean;
  autoPause?: boolean;
  loop?: boolean;
  muted?: boolean;
  playsInline?: boolean;
  preload?: KinescopePreload;
  controls?: boolean;
  mainPlayButton?: boolean;
  localStorage?: boolean;
  /** The player exists and its iframe is up. Not "the video has buffered". */
  onInit?: () => void;
  onPlaying?: () => void;
};

let instanceCount = 0;

export default function KinescopePlayerClient({
  videoId,
  className,
  autoPlay,
  autoPause,
  loop,
  muted,
  playsInline,
  preload,
  controls,
  mainPlayButton,
  localStorage,
  onInit,
  onPlaying,
}: KinescopePlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Held in a ref so a new inline callback on re-render cannot tear the player
  // down and build it again; only the options below justify that.
  const callbacks = useRef({ onInit, onPlaying });
  useEffect(() => {
    callbacks.current = { onInit, onPlaying };
  }, [onInit, onPlaying]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let player: KinescopePlayerInstance | null = null;

    // The API replaces this element with its iframe, so it is created fresh
    // per run and is already in the document before anything is asked of it.
    const mount = document.createElement("div");
    mount.id = `kinescope-player-${(instanceCount += 1)}`;
    mount.style.width = "100%";
    mount.style.height = "100%";
    host.replaceChildren(mount);

    void loadIframeApi()
      .then((api) =>
        api.create(mount.id, {
          url: embedUrl(videoId),
          size: { width: "100%", height: "100%" },
          behavior: { autoPlay, autoPause, loop, muted, playsInline, preload, localStorage },
          ui: { controls, mainPlayButton },
        }),
      )
      .then((created) => {
        if (cancelled) {
          void created.destroy().catch(() => {});
          return;
        }
        player = created;
        created.on(created.Events.Playing, () => callbacks.current.onPlaying?.());
        callbacks.current.onInit?.();
      })
      // Swallowed deliberately: both surfaces are decorative or self-contained,
      // and a blocked script must not take the page down with it.
      .catch(() => {});

    return () => {
      cancelled = true;
      void player?.destroy().catch(() => {});
      host.replaceChildren();
    };
  }, [
    videoId,
    autoPlay,
    autoPause,
    loop,
    muted,
    playsInline,
    preload,
    controls,
    mainPlayButton,
    localStorage,
  ]);

  return <div ref={hostRef} className={className} />;
}
