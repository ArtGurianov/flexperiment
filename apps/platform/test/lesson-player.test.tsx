// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LessonPlayer, { playbackEmbedUrl } from "../components/kinescope/LessonPlayer";
import { loadIframeApi } from "../components/kinescope/iframeApi";

vi.mock("../components/kinescope/iframeApi", () => ({ loadIframeApi: vi.fn() }));

const response = (body: unknown) => Response.json(body);

describe("LessonPlayer", () => {
  const handlers: Record<string, (event: { data?: { currentTime?: number } }) => void> = {};
  const player = {
    Events: { TimeUpdate: "time", Pause: "pause", Error: "error", Unsupported: "unsupported" },
    on: vi.fn((event: string, handler: (event: { data?: { currentTime?: number } }) => void) => { handlers[event] = handler; }),
    getCurrentTime: vi.fn(async () => 47),
    seekTo: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  const create = vi.fn(async (elementId: string, options: { url: string; behavior: { localStorage: boolean } }) => {
    void elementId;
    void options;
    return player;
  });
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.mocked(loadIframeApi).mockResolvedValue({ create });
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    Object.values(player).forEach((value) => { if (typeof value === "function" && "mockClear" in value) value.mockClear(); });
    create.mockClear();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes the protected authorization token to Kinescope and restores resume", async () => {
    global.fetch = vi.fn(async () => response({
      mode: "protected", videoId: "private/video", token: "signed token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), resumeAt: 31,
    }));

    render(<LessonPlayer lessonRef="lesson" title="Lesson" />);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toMatchObject({
      url: "https://kinescope.io/embed/private%2Fvideo?drmauthtoken=signed+token",
      behavior: { localStorage: false },
    });
    expect(player.seekTo).toHaveBeenCalledWith(31);
  });

  it("keeps the latest time event for pagehide beacon persistence", async () => {
    global.fetch = vi.fn(async (input) => String(input).includes("/resume")
      ? response({ accepted: true })
      : response({ mode: "open", videoId: "video", resumeAt: 0 }));
    const sendBeacon = vi.fn((url: string, data?: BodyInit | null) => {
      void url;
      void data;
      return true;
    });
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    render(<LessonPlayer lessonRef="lesson" title="Lesson" />);
    await waitFor(() => expect(handlers.time).toBeTypeOf("function"));

    act(() => handlers.time({ data: { currentTime: 42.9 } }));
    act(() => window.dispatchEvent(new Event("pagehide")));

    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(sendBeacon.mock.calls[0]?.[0]).toBe("/v1/lessons/lesson/resume");
    const payloadText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsText(sendBeacon.mock.calls[0]![1] as Blob);
    });
    const payload = JSON.parse(payloadText) as { seconds: number };
    expect(payload.seconds).toBe(42);
  });

  it("refreshes a protected grant before it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T04:00:00Z"));
    const grants = [
      { mode: "protected", videoId: "video", token: "first", expiresAt: "2026-10-01T04:00:40Z", resumeAt: 0 },
      { mode: "protected", videoId: "video", token: "second", expiresAt: "2026-10-01T04:02:00Z", resumeAt: 0 },
    ];
    global.fetch = vi.fn(async () => response(grants.shift()));
    render(<LessonPlayer lessonRef="lesson" title="Lesson" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const playbackRequests = vi.mocked(global.fetch).mock.calls.filter(([input, init]) =>
      String(input) === "/v1/lessons/lesson/playback" && init?.method === "POST");
    expect(playbackRequests).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1]).toMatchObject({ url: "https://kinescope.io/embed/video?drmauthtoken=second" });
  });

  it("never embeds an already expired protected grant", async () => {
    global.fetch = vi.fn(async () => response({
      mode: "protected", videoId: "video", token: "expired", expiresAt: "2020-01-01T00:00:00Z", resumeAt: 0,
    }));
    render(<LessonPlayer lessonRef="lesson" title="Lesson" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(create).not.toHaveBeenCalled());
  });

  it("never adds a DRM token to an open embed", () => {
    expect(playbackEmbedUrl({ mode: "open", videoId: "video", resumeAt: 0 })).toBe("https://kinescope.io/embed/video");
  });
});
