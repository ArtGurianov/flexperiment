import { afterEach, describe, expect, it, vi } from "vitest";
import { videoUploadEndpoints } from "../lib/video-upload-endpoints";

const endpoint = (path: string) => videoUploadEndpoints.find((candidate) => candidate.path === path)!;
const upload = { lessonRef: "lesson", title: "Lesson", filename: "lesson.mp4", filesize: 1_048_576 };

describe("author video upload boundary", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requires an authenticated Payload author before creating an upload", async () => {
    const response = await endpoint("/video-upload").handler({
      user: null,
      json: async () => upload,
    } as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "AUTHOR_REQUIRED" });
  });

  it("forwards only the private service credential and returns no video id", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://commerce.internal");
    vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "service-token");
    global.fetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-token");
      expect(JSON.parse(String(init?.body))).toEqual(upload);
      return Response.json({ uploadSessionId: "session", endpoint: "https://tus.example/upload" }, { status: 201 });
    });

    const response = await endpoint("/video-upload").handler({
      user: { collection: "users" },
      json: async () => ({ ...upload, videoId: "smuggled" }),
    } as never);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ uploadSessionId: "session", endpoint: "https://tus.example/upload" });
    expect(JSON.stringify(body).includes("videoId")).toBe(false);
  });

  it("rejects an upload without the file name and size Kinescope init requires", async () => {
    global.fetch = vi.fn();
    for (const invalid of [
      { lessonRef: "lesson", title: "Lesson" },
      { ...upload, filename: "" },
      { ...upload, filesize: 0 },
      { ...upload, filesize: "1024" },
    ]) {
      const response = await endpoint("/video-upload").handler({
        user: { collection: "users" },
        json: async () => invalid,
      } as never);
      expect(response.status).toBe(422);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps upload status polling author-only", async () => {
    const response = await endpoint("/video-upload/:id").handler({ user: null, routeParams: { id: "session" } } as never);
    expect(response.status).toBe(401);
  });
});
