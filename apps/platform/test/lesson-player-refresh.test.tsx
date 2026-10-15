// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LessonPlayer from "../components/kinescope/LessonPlayer";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../components/kinescope/iframeApi", () => ({ loadIframeApi: async () => sdk }));
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const grant = (token = "synthetic-first", videoId = "synthetic-video") => ({
  mode: "protected", videoId, token, resumeAt: 35, expiresAt: new Date(Date.now() + 120_000).toISOString(),
});
const player = () => ({ Events: { TimeUpdate: "time", Pause: "pause", Error: "error", Unsupported: "unsupported" },
  on: vi.fn(), seekTo: vi.fn(async () => {}), getCurrentTime: vi.fn(async () => 35),
  destroy: vi.fn(async () => {}), setPlaylistItemOptions: vi.fn<(value: unknown) => Promise<void>>().mockResolvedValue(undefined),
});
const originalFetch = global.fetch;
let current: ReturnType<typeof player>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  current = player(); sdk.create.mockReset(); sdk.create.mockResolvedValue(current);
  global.fetch = vi.fn(async (_url, options) => options?.method === "PUT" ? Response.json({ accepted: true }) : Response.json(grant()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); global.fetch = originalFetch; vi.restoreAllMocks(); });

async function start() { render(<LessonPlayer lessonRef="synthetic-lesson" title="Fixture" />); await flush(); expect(sdk.create).toHaveBeenCalledTimes(1); }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("protected player grant renewal", () => {
  it("updates the token in the existing player without losing playback or seeking again", async () => {
    await start();
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : Response.json(grant("synthetic-renewed")));
    await advance(90_000);
    expect(current.setPlaylistItemOptions).toHaveBeenCalledWith({ drm: { auth: { token: "synthetic-renewed" } } });
    expect(sdk.create).toHaveBeenCalledTimes(1); expect(current.destroy).not.toHaveBeenCalled();
    expect(current.seekTo).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 503])("removes the existing player when renewal is denied (%s)", async status => {
    await start(); vi.mocked(global.fetch).mockResolvedValue(Response.json({ decision: "DENY" }, { status }));
    await advance(90_000); expect(current.destroy).toHaveBeenCalledTimes(1);
    expect(current.setPlaylistItemOptions).not.toHaveBeenCalled(); expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("does not keep an old player after the provider refuses a token update", async () => {
    await start(); current.setPlaylistItemOptions.mockRejectedValue(new Error("synthetic SDK failure"));
    await advance(90_000);
    expect(current.destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Видео сейчас не загрузилось/)).toBeInTheDocument();
  });

  it("fails closed on an unacknowledged SDK update instead of extending the old token lifetime", async () => {
    await start(); current.setPlaylistItemOptions.mockImplementation(() => new Promise(() => {}));
    await advance(95_001);
    expect(current.setPlaylistItemOptions).toHaveBeenCalledTimes(1);
    expect(current.destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(1);
    await advance(120_000); expect(current.setPlaylistItemOptions).toHaveBeenCalledTimes(1);
  });

  it("does not accept a late renewal response after unmount", async () => {
    await start(); let resolve!: (r: Response) => void;
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : new Promise(r => { resolve = r; }));
    await advance(90_000); cleanup(); resolve(Response.json(grant("synthetic-late"))); await flush();
    expect(current.setPlaylistItemOptions).not.toHaveBeenCalled(); expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("does not reopen or schedule renewal after an SDK acknowledgement arrives after unmount", async () => {
    await start(); let acknowledge!: () => void;
    current.setPlaylistItemOptions.mockImplementation(() => new Promise<void>(r => { acknowledge = r; }));
    await advance(90_000); cleanup(); acknowledge(); await flush();
    await advance(240_000);
    expect(current.setPlaylistItemOptions).toHaveBeenCalledTimes(1);
    expect(sdk.create).toHaveBeenCalledTimes(1); expect(current.destroy).toHaveBeenCalledTimes(1);
  });

  it("replaces the instance for a changed active video binding", async () => {
    await start(); vi.mocked(global.fetch).mockResolvedValue(Response.json(grant("synthetic-new", "replacement-video")));
    await advance(90_000); expect(current.destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(current.setPlaylistItemOptions).not.toHaveBeenCalled();
  });

  it("does not carry a prior lesson or its renewal into a new lesson", async () => {
    const view = render(<LessonPlayer lessonRef="first" title="Fixture" />); await flush();
    let resolve!: (r: Response) => void;
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : new Promise(r => { resolve = r; }));
    await advance(90_000);
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : Response.json(grant("second", "second-video")));
    view.rerender(<LessonPlayer lessonRef="second" title="Second" />); await flush();
    resolve(Response.json(grant("late-first"))); await flush();
    expect(sdk.create).toHaveBeenCalledTimes(2); expect(current.destroy).toHaveBeenCalledTimes(1);
    expect(current.setPlaylistItemOptions).not.toHaveBeenCalled();
    expect(sdk.create.mock.calls[1][1].url).toContain("second-video");
  });

  it("tears down by the old expiry when renewal GETs keep failing", async () => {
    await start(); vi.mocked(global.fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") return Response.json({ accepted: true });
      throw new Error("synthetic transport failure");
    });
    await advance(120_001); expect(current.destroy).toHaveBeenCalledTimes(1);
    expect(current.setPlaylistItemOptions).not.toHaveBeenCalled();
    expect(screen.getByText(/Видео сейчас не загрузилось/)).toBeInTheDocument();
  });

  it("rejects an unknown delivery mode before touching the SDK", async () => {
    vi.mocked(global.fetch).mockResolvedValue(Response.json({ ...grant(), mode: "unexpected" }));
    render(<LessonPlayer lessonRef="fixture" title="Fixture" />); await flush();
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
