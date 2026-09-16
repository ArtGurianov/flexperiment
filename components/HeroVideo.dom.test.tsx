import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const kinescope = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
  play: vi.fn().mockResolvedValue(undefined),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
}));

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("./kinescope/KinescopePlayer", () => ({
  default: ({ forwardRef, ...props }: {
    forwardRef?: { current: typeof kinescope.play | null };
    [key: string]: unknown;
  }) => {
    kinescope.props.push(props);
    if (forwardRef) {
      forwardRef.current = {
        play: kinescope.play,
        setFullscreen: kinescope.setFullscreen,
      } as unknown as typeof kinescope.play;
    }
    return <div data-testid="kinescope-player" />;
  },
}));

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));

import HeroBackgroundVideo from "./HeroBackgroundVideo";
import HeroVideo from "./HeroVideo";

type BackgroundProps = {
  videoId: string;
  autoPlay: boolean;
  loop: boolean;
  muted: boolean;
  playsInline: boolean;
  controls: boolean;
  mainPlayButton: boolean;
  preload: boolean;
  onPlaying: () => void;
};

type ForegroundProps = {
  videoId: string;
  autoPlay: boolean;
  controls: boolean;
  preload: string;
  onPlay: () => void;
};

afterEach(() => {
  kinescope.props.length = 0;
  kinescope.play.mockClear();
  kinescope.setFullscreen.mockClear();
  motion.reduced = false;
  vi.restoreAllMocks();
  delete (navigator as Navigator & { connection?: unknown }).connection;
});

describe("HeroVideo", () => {
  it("uses the supplied Kinescope hero ID and keeps the custom watch affordance", () => {
    render(<HeroVideo />);

    const props = kinescope.props[0] as ForegroundProps;
    expect(props).toMatchObject({
      videoId: "i7n65WzZnSd4bVUBE1mzi5",
      autoPlay: false,
      controls: true,
      preload: "metadata",
    });

    fireEvent.click(screen.getByRole("button", { name: "Смотреть видео" }));
    expect(kinescope.setFullscreen).toHaveBeenCalledWith(true);
    expect(kinescope.play).toHaveBeenCalledOnce();

    act(() => props.onPlay());
    expect(screen.getByRole("button", { name: "Смотреть видео" })).toHaveAttribute("inert");
  });
});

describe("HeroBackgroundVideo", () => {
  it("keeps the poster visible until idle playback and configures a silent decorative player", () => {
    const idleCallbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return 1;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: vi.fn() });

    const { container } = render(<HeroBackgroundVideo videoId="background-id" />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("background.webp"),
    );
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();

    act(() => idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 50 }));
    const props = kinescope.props[0] as BackgroundProps;
    expect(props).toMatchObject({
      videoId: "background-id",
      autoPlay: true,
      loop: true,
      muted: true,
      playsInline: true,
      controls: false,
      mainPlayButton: false,
      preload: false,
    });

    act(() => props.onPlaying());
    expect(screen.getByTestId("kinescope-player").parentElement).toHaveClass("opacity-100");
  });

  it.each([
    ["reduced-motion", () => { motion.reduced = true; }],
    ["Save-Data", () => {
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData: true },
      });
    }],
  ])("never mounts Kinescope for %s visitors", (_label, prepare) => {
    prepare();
    const idle = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: idle });

    render(<HeroBackgroundVideo videoId="background-id" />);
    expect(idle).not.toHaveBeenCalled();
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();
  });
});
