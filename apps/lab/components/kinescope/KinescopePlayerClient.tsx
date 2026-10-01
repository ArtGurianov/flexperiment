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
  /** The video is on screen and running. The only event that means pixels. */
  onPlaying?: () => void;
  /**
   * This player will not play: the API was blocked, or the player reported an
   * error or an unsupported stream. Fires at most once, and never after
   * unmount. Anything waiting on onPlaying needs this, because after a failure
   * onPlaying is not late — it is never coming.
   */
  onError?: () => void;
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
  onPlaying,
  onError,
}: KinescopePlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Held in a ref so a new inline callback on re-render cannot tear the player
  // down and build it again; only the options below justify that.
  const callbacks = useRef({ onPlaying, onError });
  useEffect(() => {
    callbacks.current = { onPlaying, onError };
  }, [onPlaying, onError]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let player: KinescopePlayerInstance | null = null;
    // One failure report per player. Error and Unsupported can both arrive for
    // the same broken stream, and a gate released twice is a gate that can
    // release someone else's slot.
    let failed = false;
    const fail = () => {
      if (cancelled || failed) return;
      failed = true;
      callbacks.current.onError?.();
    };

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
        created.on(created.Events.Error, fail);
        created.on(created.Events.Unsupported, fail);
      })
      // Never rethrown: both surfaces are decorative or self-contained, and a
      // blocked script must not take the page down with it. It is still
      // reported, though — swallowing it silently is how a caller waiting for
      // this player ends up waiting for something that cannot arrive.
      .catch(fail);

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
