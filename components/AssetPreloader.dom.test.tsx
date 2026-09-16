import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The loader's artwork comes in as static imports, which resolve to bare
// strings here and make next/image demand explicit dimensions. None of that is
// what these tests are about.
vi.mock("next/image", () => ({
  default: ({ src, ...rest }: { src: unknown; [key: string]: unknown }) => (
    <img alt="" src={typeof src === "string" ? src : ""} {...rest} />
  ),
}));

import AssetPreloader, { useLoaderGate } from "./AssetPreloader";

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
