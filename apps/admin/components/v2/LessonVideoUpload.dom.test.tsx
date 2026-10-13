import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { LessonVideoUpload } from "./LessonVideoUpload";

const tus = vi.hoisted(() => ({ started: vi.fn(), abort: vi.fn(), onSuccess: null as (() => void) | null }));
vi.mock("tus-js-client", () => ({
  Upload: class {
    constructor(_file: File, options: { onSuccess: () => void }) { tus.onSuccess = options.onSuccess; }
    start() { tus.started(); }
    abort() { tus.abort(); }
  },
}));

const response = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
}) as Response;

describe("Control Room lesson video upload", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; tus.started.mockClear(); tus.abort.mockClear(); tus.onSuccess = null; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("uses an admin session for init/status and sends bytes only to the Tus endpoint", async () => {
    let uploadState: "none" | "UPLOADING" | "READY" = "none";
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/v2/courses/course/published")) return response({ lessons: [{ lesson_ref: "lesson", title: "Tour", section_ref: "section" }] });
      if (path.endsWith("/v2/lessons/lesson/video-upload")) return response({
        upload: uploadState === "none" ? null : { uploadSessionId: "session-1", state: uploadState, errorCode: null },
        activeBinding: uploadState === "READY", activeDurationSeconds: uploadState === "READY" ? 4 : null,
      });
      if (path.endsWith("/v2/video-uploads") && init?.method === "POST") {
        uploadState = "UPLOADING";
        return response({ uploadSessionId: "session-1", endpoint: "https://uploader.kinescope.io/v2/upload/test" }, 201);
      }
      if (path.endsWith("/v2/video-uploads/session-1")) return response({ state: uploadState });
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<LessonVideoUpload courses={[
      { courseRef: "course", projection: { version: 1, authoringSource: "COMMERCE_EDITORIAL" } },
      { courseRef: "legacy", projection: { version: 1, authoringSource: "LEGACY_MANIFEST" } },
    ]} />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    expect(screen.queryByRole("option", { name: "legacy" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Курс"), "course");
    await user.selectOptions(await screen.findByLabelText("Урок"), "lesson");
    await user.upload(screen.getByLabelText("Видеофайл"), new File(["video-bytes"], "tour.mp4", { type: "video/mp4" }));
    await waitFor(() => expect(tus.started).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith("/v2/video-uploads") && options?.method === "POST");
    expect(init).toBeDefined();
    expect(init?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.[1]?.body))).toEqual({ lessonRef: "lesson", title: "Tour", filename: "tour.mp4", filesize: 11 });
    expect(JSON.stringify(init)).not.toContain("videoId");

    uploadState = "READY";
    tus.onSuccess?.();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Видео обработано и привязано к уроку."));
    expect(screen.getByText(/длительность 4 с/)).toBeInTheDocument();
  });

  it("recovers a persisted processing session after the editor reloads", async () => {
    let state: "PROCESSING" | "READY" = "PROCESSING";
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/v2/courses/course/published")) return response({ lessons: [{ lesson_ref: "lesson", title: "Tour", section_ref: "section" }] });
      if (path.endsWith("/v2/lessons/lesson/video-upload")) return response({
        upload: { uploadSessionId: "persisted-session", state, errorCode: null },
        activeBinding: state === "READY", activeDurationSeconds: state === "READY" ? 4 : null,
      });
      if (path.endsWith("/v2/video-uploads/persisted-session") && !init?.method) {
        state = "READY";
        return response({ state: "READY", durationSeconds: 4 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    global.fetch = fetchMock;
    const client = createTestQueryClient();
    const user = userEvent.setup();
    render(<LessonVideoUpload courses={[{ courseRef: "course", projection: { version: 1, authoringSource: "COMMERCE_EDITORIAL" } }]} />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.selectOptions(screen.getByLabelText("Курс"), "course");
    await user.selectOptions(await screen.findByLabelText("Урок"), "lesson");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Видео обработано и привязано к уроку."));
    expect(fetchMock).toHaveBeenCalledWith("/v1/admin/v2/video-uploads/persisted-session", expect.objectContaining({ credentials: "same-origin" }));
    expect(tus.started).not.toHaveBeenCalled();
  });
});
