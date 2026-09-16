import { act, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The loader's artwork comes in as static imports, which resolve to bare
// strings here and make next/image demand explicit dimensions. None of that is
// what these tests are about.
vi.mock("next/image", () => ({
  default: ({ src, fill, sizes, ...rest }: Record<string, unknown>) => (
    <img alt="" src={typeof src === "string" ? src : ""} {...rest} />
  ),
}));

const kinescope = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
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

import AssetPreloader, { useLoaderGate } from "./AssetPreloader";
import HeroBackgroundVideo from "./HeroBackgroundVideo";

/** The overlay itself. Queried directly: it carries aria-hidden once it starts
 *  fading, which puts it outside the accessible tree role queries search. */
const overlay = () => document.querySelector('[role="status"]')!;

/** Resolves every image fetch the preloader makes, then lets its promises run. */
const settleImages = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function Registrant({ onRelease }: { onRelease: (release: () => void) => void }) {
  const gate = useLoaderGate();
  // Mirrors HeroBackgroundVideo: claim on mount, hand the release outward.
  const claim = () => {
    if (!gate) return;
    onRelease(gate.register());
  };
  return <button type="button" onClick={claim} ref={() => claim()} />;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      headers: { get: () => null },
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }),
  );
});

afterEach(() => {
  kinescope.props.length = 0;
  motion.reduced = false;
  delete (navigator as Navigator & { connection?: unknown }).connection;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AssetPreloader loader gate", () => {
  it("hands over on the images alone when nothing registers", async () => {
    render(<AssetPreloader><p>page</p></AssetPreloader>);
    expect(overlay()).toHaveClass("opacity-100");

    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    expect(overlay()).toHaveClass("opacity-0");
  });

  it("keeps holding while a registrant has not released", async () => {
    const releases: Array<() => void> = [];
    render(
      <AssetPreloader>
        <Registrant onRelease={(r) => releases.push(r)} />
      </AssetPreloader>,
    );

    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    // The images are done; the gate is not. This is the whole point: without
    // it the page handed over with an empty player still on screen.
    expect(overlay()).toHaveClass("opacity-100");

    act(() => releases[0]());
    act(() => void vi.advanceTimersByTime(300));
    expect(overlay()).toHaveClass("opacity-0");
  });

  it("never holds the page past the safety ceiling", async () => {
    render(
      <AssetPreloader>
        <Registrant onRelease={() => {}} />
      </AssetPreloader>,
    );

    await settleImages();
    // Registered and deliberately never released.
    act(() => void vi.advanceTimersByTime(2500 + 300));

    expect(overlay()).toHaveClass("opacity-0");
  });
});

describe("loader gate and the hero backdrop together", () => {
  const renderHome = () =>
    render(
      <AssetPreloader>
        <HeroBackgroundVideo videoId="background-id" />
      </AssetPreloader>,
    );

  it("holds the handover until the player reports ready", async () => {
    renderHome();
    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    // The images are done and the player is mounted but silent. This is the
    // whole reason the gate exists: handing over here shows an empty box.
    expect(screen.getByTestId("kinescope-player")).toBeInTheDocument();
    expect(overlay()).toHaveClass("opacity-100");

    const props = kinescope.props[0] as { onInit: () => void };
    act(() => props.onInit());
    act(() => void vi.advanceTimersByTime(300));
    expect(overlay()).toHaveClass("opacity-0");
  });

  it.each([
    ["reduced-motion", () => { motion.reduced = true; }],
    ["Save-Data", () => {
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData: true },
      });
    }],
  ])("never makes %s visitors wait for a player they do not get", async (_l, prepare) => {
    prepare();
    renderHome();
    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    // Not just "no player": no latency for one either. #127 made this class of
    // visitor free of the decorative video, and the gate must not undo that by
    // holding them to the safety ceiling.
    expect(screen.queryByTestId("kinescope-player")).not.toBeInTheDocument();
    expect(overlay()).toHaveClass("opacity-0");
  });
});

describe("loader gate under hydration", () => {
  /**
   * The page ships as static HTML and is hydrated, and that is not what
   * Testing Library's render() does. It matters here: the eligibility check
   * reads useSyncExternalStore, whose first hydration pass is served by the
   * server snapshot. Anything deriving registration from that value registers
   * and releases on a value that is about to change.
   */
  const containers: HTMLElement[] = [];
  // hydrateRoot mounts outside Testing Library's bookkeeping, so its container
  // survives auto-cleanup and the next test's `screen` would still see it.
  afterEach(() => {
    containers.splice(0).forEach((c) => c.remove());
  });

  const hydrateHome = () => {
    const tree = (
      <AssetPreloader>
        <HeroBackgroundVideo videoId="background-id" />
      </AssetPreloader>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree);
    document.body.appendChild(container);
    containers.push(container);
    act(() => {
      hydrateRoot(container, tree);
    });
    return within(container);
  };

  it("still holds the handover until the player reports ready", async () => {
    const home = hydrateHome();
    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    expect(home.getByTestId("kinescope-player")).toBeInTheDocument();
    expect(home.getByRole("status", { hidden: true })).toHaveClass("opacity-100");
  });

  it.each([
    ["reduced-motion", () => { motion.reduced = true; }],
    ["Save-Data", () => {
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData: true },
      });
    }],
  ])("does not hold %s visitors, who get no player", async (_l, prepare) => {
    prepare();
    const home = hydrateHome();
    await settleImages();
    act(() => void vi.advanceTimersByTime(300));

    expect(home.queryByTestId("kinescope-player")).not.toBeInTheDocument();
    expect(home.getByRole("status", { hidden: true })).toHaveClass("opacity-0");
  });
});
