import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kinescope = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

const motion = vi.hoisted(() => ({ reduced: false }));

vi.mock("./kinescope/KinescopePlayer", () => ({
  default: (props: Record<string, unknown>) => {
    kinescope.props.push(props);
    return <div data-testid="kinescope-player" />;
  },
}));

vi.mock("@/hooks/usePrefersReducedMotion", () => ({
  usePrefersReducedMotion: () => motion.reduced,
}));

import HeroBackgroundVideo from "./HeroBackgroundVideo";
import HeroVideo from "./HeroVideo";

const originalUserAgent = navigator.userAgent;

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
  mainPlayButton: boolean;
  preload: string;
  onPlay: () => void;
};

/** The branded cover, which is decorative and so has no accessible name. */
const cover = () => document.querySelector("section > div[aria-hidden]")!;

afterEach(() => {
  kinescope.props.length = 0;
  motion.reduced = false;
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: originalUserAgent,
  });
  delete (navigator as Navigator & { connection?: unknown }).connection;
});

describe("HeroVideo", () => {
  it("leaves the player's own play button reachable through the cover", () => {
    render(<HeroVideo />);

    const props = kinescope.props[0] as ForegroundProps;
    expect(props).toMatchObject({
      videoId: "i7n65WzZnSd4bVUBE1mzi5",
      autoPlay: false,
      controls: true,
      // Never inherited: this is the control that starts playback now.
      mainPlayButton: true,
      preload: "metadata",
    });

    // The gesture has to land inside the iframe to count as user activation
    // there, so nothing in this document may sit in front of the player or
    // offer a competing affordance.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(cover()).toHaveClass("pointer-events-none");
  });

  it("clips Kinescope's own corner radius by bleeding the player past the section", () => {
    const { container } = render(<HeroVideo />);

    const section = container.querySelector("section")!;
    expect(section).toHaveClass("overflow-hidden");
    expect(screen.getByTestId("kinescope-player").parentElement).toHaveClass("-inset-[14px]");
  });

  it("fades the cover out on the play event", () => {
    render(<HeroVideo />);
    expect(cover()).toHaveClass("opacity-100");

    act(() => (kinescope.props[0] as ForegroundProps).onPlay());
    expect(cover()).toHaveClass("opacity-0");
  });

  it("fades the cover out on a press into the player when no play event arrives", () => {
    const { container } = render(<HeroVideo />);
    const section = container.querySelector("section")!;
    // The mock stands in for the player; the real one renders this iframe, and
    // a press on its play button is only ever visible here as focus moving.
    const frame = document.createElement("iframe");
    section.append(frame);

    act(() => {
      frame.focus();
      window.dispatchEvent(new Event("blur"));
    });

    expect(cover()).toHaveClass("opacity-0");
  });

  it("ignores a window blur that did not hand focus to the player", () => {
    render(<HeroVideo />);

    act(() => {
      document.body.focus();
      window.dispatchEvent(new Event("blur"));
    });

    expect(cover()).toHaveClass("opacity-100");
  });

  it("applies and restores Kinescope's iOS pseudo-fullscreen styles only for its iframe", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    const { container } = render(<HeroVideo />);
    const frame = document.createElement("iframe");
    frame.style.cssText = "width:640px;height:360px";
    container.querySelector("section")!.append(frame);

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "KINESCOPE_PLAYER_FULLSCREEN_CHANGE", value: true },
        source: frame.contentWindow!,
      }));
    });
    expect(frame.style.position).toBe("fixed");
    expect(frame.style.width).toBe("100%");
    expect(frame.dataset.kinescopeOriginalStyles).toBe("width: 640px; height: 360px;");

    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "KINESCOPE_PLAYER_FULLSCREEN_CHANGE", value: false },
        source: frame.contentWindow!,
      }));
    });
    expect(frame.style.position).toBe("");
    expect(frame.style.width).toBe("640px");
    expect(frame.style.height).toBe("360px");
    expect(frame.dataset.kinescopeOriginalStyles).toBeUndefined();
  });
});

describe("HeroBackgroundVideo", () => {
  const idleCallbacks: IdleRequestCallback[] = [];

  beforeEach(() => {
    idleCallbacks.length = 0;
    vi.useFakeTimers();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return 1;
      }),
    });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mountPlayer = () => {
    const result = render(<HeroBackgroundVideo videoId="background-id" />);
    act(() => idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 50 }));
    return result;
  };

  it("keeps the poster visible until idle and configures a silent decorative player", () => {
    const { container } = render(<HeroBackgroundVideo videoId="background-id" />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("background.webp"),
    );
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();

    act(() => idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 50 }));
    expect(kinescope.props[0] as BackgroundProps).toMatchObject({
      videoId: "background-id",
      autoPlay: true,
      loop: true,
      muted: true,
      playsInline: true,
      controls: false,
      mainPlayButton: false,
      preload: false,
    });
  });

  it("covers the square container with an oversized 16:9 box", () => {
    mountPlayer();

    // A square container and a 16:9 source: object-fit is inside the iframe and
    // out of reach, so the box itself has to carry the cover geometry.
    const wrapper = screen.getByTestId("kinescope-player").parentElement!;
    expect(wrapper).toHaveClass("h-[calc(100%_+_28px)]");
    expect(wrapper).toHaveClass("w-[calc((100%_+_28px)_*_16_/_9)]");
    expect(wrapper).toHaveClass("-translate-x-1/2", "-translate-y-1/2");
  });

  it("reveals the backdrop on the playing event", () => {
    mountPlayer();
    const wrapper = screen.getByTestId("kinescope-player").parentElement!;
    expect(wrapper).toHaveClass("opacity-0");

    act(() => (kinescope.props[0] as BackgroundProps).onPlaying());
    expect(wrapper).toHaveClass("opacity-100");
  });

  it("reveals the backdrop on a timer when the playing event never arrives", () => {
    // Kinescope's message bridge has been seen to deliver its handshake and
    // then nothing. Gated solely on onPlaying, the backdrop stayed invisible.
    mountPlayer();
    expect(screen.getByTestId("kinescope-player").parentElement).toHaveClass("opacity-0");

    act(() => void vi.advanceTimersByTime(2000));
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
    render(<HeroBackgroundVideo videoId="background-id" />);
    expect(idleCallbacks).toHaveLength(0);
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();
  });
});
