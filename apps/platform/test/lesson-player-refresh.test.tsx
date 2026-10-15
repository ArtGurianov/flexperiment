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
type Event = { data?: { currentTime?: number } };
const player = () => {
  const handlers: Record<string, (event: Event) => void> = {};
  return { handlers, Events: { TimeUpdate: "time", Pause: "pause", Playing: "playing", Ended: "ended", Error: "error", Unsupported: "unsupported" },
    on: vi.fn((event: string, handler: (event: Event) => void) => { handlers[event] = handler; }),
    seekTo: vi.fn(async () => {}), getCurrentTime: vi.fn(async () => 35),
    destroy: vi.fn(async () => {}), play: vi.fn(async () => {}),
  };
};
const originalFetch = global.fetch;
let instances: ReturnType<typeof player>[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
  instances = []; sdk.create.mockReset(); sdk.create.mockImplementation(async () => { const p = player(); instances.push(p); return p; });
  global.fetch = vi.fn(async (_url, options) => options?.method === "PUT" ? Response.json({ accepted: true }) : Response.json(grant()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); global.fetch = originalFetch; vi.restoreAllMocks(); });
async function start() { const view = render(<LessonPlayer lessonRef="synthetic-lesson" title="Fixture" />); await flush(); expect(sdk.create).toHaveBeenCalledTimes(1); return view; }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const playing = () => act(() => instances[0].handlers.playing({}));

describe("protected player renewal with supported iframe controls", () => {
  it("continues a playing lesson at the latest observed position with a fresh-token iframe", async () => {
    await start(); playing(); act(() => instances[0].handlers.time({ data: { currentTime: 77.8 } })); await flush();
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : Response.json(grant("synthetic-renewed")));
    await advance(90_000);
    expect(instances[0].destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(sdk.create.mock.calls[1][1].url).toContain("drmauthtoken=synthetic-renewed");
    expect(instances[1].seekTo).toHaveBeenCalledWith(77); expect(instances[1].play).toHaveBeenCalledTimes(1);
  });
  it.each(["initially paused", "explicit pause", "ended"])("preserves %s without autoplay", async state => {
    await start();
    if (state !== "initially paused") { playing(); act(() => instances[0].handlers[state === "ended" ? "ended" : "pause"]({})); await flush(); }
    await advance(90_000); expect(sdk.create).toHaveBeenCalledTimes(2); expect(instances[1].play).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])("removes playing media without replacing it after denied renewal (%s)", async status => {
    await start(); playing(); vi.mocked(global.fetch).mockResolvedValue(Response.json({ decision: "DENY" }, { status }));
    await advance(90_000); expect(instances[0].destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(1);
  });
  it("fails closed when the new iframe cannot be created", async () => {
    await start(); playing(); sdk.create.mockRejectedValue(new Error("synthetic create failure"));
    await advance(90_000); expect(instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Видео сейчас не загрузилось/)).toBeInTheDocument();
  });
  it("keeps valid playback controls available if the browser refuses automatic play", async () => {
    await start(); playing(); const next = player(); next.play.mockRejectedValue(new Error("synthetic autoplay policy")); sdk.create.mockResolvedValue(next);
    await advance(90_000); expect(next.play).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Видео: Fixture")).toBeInTheDocument(); expect(screen.queryByText(/Видео сейчас не загрузилось/)).not.toBeInTheDocument();
  });
  it("does not silently restart at zero if restoring the known position fails", async () => {
    await start(); playing(); const next = player(); next.seekTo.mockRejectedValue(new Error("synthetic seek uncertainty")); sdk.create.mockResolvedValue(next);
    await advance(90_000); expect(next.play).not.toHaveBeenCalled();
    expect(screen.getByText(/Видео сейчас не загрузилось/)).toBeInTheDocument();
  });
  it("destroys a late-created replacement after unmount without playing it", async () => {
    await start(); playing(); let resolve!: (p: ReturnType<typeof player>) => void; sdk.create.mockImplementation(() => new Promise(r => { resolve = r; }));
    await advance(90_000); cleanup(); const late = player(); resolve(late); await flush();
    expect(late.destroy).toHaveBeenCalledTimes(1); expect(late.play).not.toHaveBeenCalled();
  });
  it("ignores late events from the removed instance", async () => {
    await start(); playing(); await advance(90_000);
    act(() => { instances[0].handlers.pause({}); instances[0].handlers.time({ data: { currentTime: 999 } }); });
    act(() => { instances[1].handlers.playing({}); instances[1].handlers.time({ data: { currentTime: 82 } }); }); await flush();
    await advance(90_000); expect(instances[2].seekTo).toHaveBeenCalledWith(82); expect(instances[2].play).toHaveBeenCalledTimes(1);
  });
  it("does not accept a late renewal response after unmount", async () => {
    await start(); let resolve!: (r: Response) => void;
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : new Promise(r => { resolve = r; }));
    await advance(90_000); cleanup(); resolve(Response.json(grant("late"))); await flush(); expect(sdk.create).toHaveBeenCalledTimes(1);
  });
  it("honours a viewer pause while the new grant GET is pending", async () => {
    await start(); playing(); let resolve!: (r: Response) => void;
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : new Promise(r => { resolve = r; }));
    await advance(90_000); act(() => instances[0].handlers.pause({})); await flush();
    resolve(Response.json(grant("renewed"))); await flush();
    expect(sdk.create).toHaveBeenCalledTimes(2); expect(instances[1].play).not.toHaveBeenCalled();
  });
  it("does not let a stale outgoing SDK read overwrite replacement progress", async () => {
    await start(); playing(); let resolve!: (n: number) => void;
    instances[0].getCurrentTime.mockImplementation(() => new Promise(r => { resolve = r; }));
    act(() => instances[0].handlers.pause({})); playing();
    act(() => instances[0].handlers.time({ data: { currentTime: 77 } })); await flush();
    await advance(90_000); act(() => { instances[1].handlers.playing({}); instances[1].handlers.time({ data: { currentTime: 81 } }); });
    await flush(); resolve(12); await flush(); await advance(90_000);
    expect(instances[2].seekTo).toHaveBeenCalledWith(81);
  });
  it("does not autoplay a replacement video binding", async () => {
    await start(); playing(); vi.mocked(global.fetch).mockResolvedValue(Response.json(grant("new", "replacement-video")));
    await advance(90_000); expect(instances[0].destroy).toHaveBeenCalledTimes(1); expect(instances[1].play).not.toHaveBeenCalled();
  });
  it("does not inherit playback or a late grant from a different lesson", async () => {
    const view = await start(); playing(); let resolve!: (r: Response) => void;
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : new Promise(r => { resolve = r; }));
    await advance(90_000);
    vi.mocked(global.fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? Response.json({ accepted: true }) : Response.json(grant("second", "second-video")));
    view.rerender(<LessonPlayer lessonRef="second" title="Second" />); await flush(); resolve(Response.json(grant("late-first"))); await flush();
    expect(sdk.create).toHaveBeenCalledTimes(2); expect(instances[1].play).not.toHaveBeenCalled(); expect(sdk.create.mock.calls[1][1].url).toContain("second-video");
  });
  it("tears down by the old expiry when renewal GETs keep failing", async () => {
    await start(); playing(); vi.mocked(global.fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") return Response.json({ accepted: true }); throw new Error("synthetic transport failure");
    });
    await advance(120_001); expect(instances[0].destroy).toHaveBeenCalledTimes(1); expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Видео сейчас не загрузилось/)).toBeInTheDocument();
  });
  it("rejects an unknown delivery mode before touching the SDK", async () => {
    vi.mocked(global.fetch).mockResolvedValue(Response.json({ ...grant(), mode: "unexpected" }));
    render(<LessonPlayer lessonRef="fixture" title="Fixture" />); await flush(); expect(sdk.create).not.toHaveBeenCalled();
  });
});
