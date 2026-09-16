import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import KinescopePlayerClient from "./KinescopePlayerClient";

type Created = {
  Events: Record<string, string>;
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

/** Whether the element the API was handed was actually in the document. */
let idsResolvedAtCreate: Array<string | null>;
let created: Created[];
let create: ReturnType<typeof vi.fn>;
let resolveCreate: ((player: Created) => void) | null;

const newPlayer = (): Created => ({
  Events: { Playing: "playing", Error: "error", Unsupported: "unsupported" },
  on: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined),
});

/** The handler this player registered for one of its events. */
const handlerFor = (player: Created, event: string): (() => void) => {
  const call = player.on.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`no handler registered for ${event}`);
  return call[1] as () => void;
};

beforeEach(() => {
  idsResolvedAtCreate = [];
  created = [];
  resolveCreate = null;
  create = vi.fn((elementId: string) => {
    idsResolvedAtCreate.push(document.getElementById(elementId) ? elementId : null);
    const player = newPlayer();
    created.push(player);
    return new Promise<Created>((resolve) => {
      resolveCreate = resolve;
      // Default: settle on the microtask queue like the real loader does.
      queueMicrotask(() => resolve(player));
    });
  });
  window.Kinescope = { IframePlayer: { create } } as unknown as Window["Kinescope"];
});

afterEach(() => {
  delete window.Kinescope;
  vi.restoreAllMocks();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("KinescopePlayerClient", () => {
  it("creates the player against an element already in the document", async () => {
    render(<KinescopePlayerClient videoId="abc" className="h-full w-full" />);
    await flush();

    // The defect this component replaces: the previous wrapper reached its
    // create path during render, when its mount point did not yet exist, and
    // silently gave up for good.
    expect(create).toHaveBeenCalledOnce();
    expect(idsResolvedAtCreate).toEqual([expect.any(String)]);
  });

  it("passes the surface's policy through to the embed", async () => {
    render(
      <KinescopePlayerClient
        videoId="abc"
        autoPlay
        loop
        muted
        playsInline
        preload={false}
        controls={false}
        mainPlayButton={false}
        localStorage={false}
      />,
    );
    await flush();

    expect(create.mock.calls[0][1]).toMatchObject({
      url: "https://kinescope.io/embed/abc",
      size: { width: "100%", height: "100%" },
      behavior: { autoPlay: true, loop: true, muted: true, preload: false, localStorage: false },
      ui: { controls: false, mainPlayButton: false },
    });
  });

  it("reports playing from the player's own event", async () => {
    const onPlaying = vi.fn();
    render(<KinescopePlayerClient videoId="abc" onPlaying={onPlaying} />);
    await flush();

    expect(onPlaying).not.toHaveBeenCalled();
    act(() => handlerFor(created[0], "playing")());
    expect(onPlaying).toHaveBeenCalledOnce();
  });

  it.each(["error", "unsupported"])("reports %s as a failure", async (event) => {
    const onError = vi.fn();
    render(<KinescopePlayerClient videoId="abc" onError={onError} />);
    await flush();

    act(() => handlerFor(created[0], event)());
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports a failure when the API never loads at all", async () => {
    // The realistic case is a blocked script, and it is the one where nothing
    // else can ever speak: create() is never reached, so no player event will
    // arrive. Callers waiting on this player have to be told here or not at all.
    create.mockRejectedValueOnce(new Error("blocked"));
    const onError = vi.fn();
    const onPlaying = vi.fn();
    render(<KinescopePlayerClient videoId="abc" onError={onError} onPlaying={onPlaying} />);
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(onPlaying).not.toHaveBeenCalled();
  });

  it("stays silent about a failure that lands after unmount", async () => {
    create.mockImplementationOnce(() => Promise.reject(new Error("blocked")));
    const onError = vi.fn();
    const { unmount } = render(<KinescopePlayerClient videoId="abc" onError={onError} />);
    unmount();
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it("does not rebuild the player when only a callback identity changes", async () => {
    const { rerender } = render(<KinescopePlayerClient videoId="abc" onPlaying={() => {}} />);
    await flush();
    rerender(<KinescopePlayerClient videoId="abc" onPlaying={() => {}} />);
    await flush();

    expect(create).toHaveBeenCalledOnce();
    expect(created[0].destroy).not.toHaveBeenCalled();
  });

  it("destroys the player and clears the host on unmount", async () => {
    const { container, unmount } = render(<KinescopePlayerClient videoId="abc" />);
    await flush();
    const host = container.firstElementChild!;
    expect(host.children).toHaveLength(1);

    unmount();
    expect(created[0].destroy).toHaveBeenCalledOnce();
    expect(host.children).toHaveLength(0);
  });

  it("destroys a player that arrives after unmount", async () => {
    // create() resolving late is the ordinary case on a slow connection; the
    // player must not be left running with nothing referencing it.
    create.mockImplementationOnce(
      () => new Promise<Created>((resolve) => {
        const player = newPlayer();
        created.push(player);
        resolveCreate = resolve;
      }),
    );
    const { unmount } = render(<KinescopePlayerClient videoId="abc" />);
    await flush();
    unmount();

    await act(async () => {
      resolveCreate!(created[0]);
      await Promise.resolve();
    });
    expect(created[0].destroy).toHaveBeenCalledOnce();
  });
});
