import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("leaves the press to the player's own button and covers nothing", () => {
    const { container } = render(<HeroVideo />);

    expect(kinescope.props[0]).toMatchObject({
      videoId: "i7n65WzZnSd4bVUBE1mzi5",
      autoPlay: false,
      controls: true,
      // The only control there is, so it must not be left to a library default.
      mainPlayButton: true,
      preload: "metadata",
    });

    // Anything of ours in front of the player would swallow the gesture that
    // has to reach the iframe to count as user activation there.
    const section = container.querySelector("section")!;
    expect(section.children).toHaveLength(1);
    expect(screen.getByTestId("kinescope-player").parentElement).toBe(section);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // The iframe is transparent until the player paints; without this the page
    // backdrop shows through the video well and through the rounded corners.
    expect(section).toHaveClass("bg-black");
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
  const mountPlayer = () => render(<HeroBackgroundVideo videoId="background-id" />);

  it("paints the local poster and configures a silent decorative player", () => {
    const { container } = mountPlayer();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("background.webp"),
    );

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

  it("reveals the backdrop on the playing event", () => {
    mountPlayer();
    const wrapper = screen.getByTestId("kinescope-player").parentElement!;
    expect(wrapper).toHaveClass("opacity-0");

    act(() => (kinescope.props[0] as BackgroundProps).onPlaying());
    expect(wrapper).toHaveClass("opacity-100");
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
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();
  });
});
