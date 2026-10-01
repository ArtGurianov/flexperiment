import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import {
  HttpKinescopeClient, observeKinescopeStatus, pollKinescopeUpload, startVideoUpload, type KinescopeClient, type KinescopeStatus,
} from "../src/kinescope";

let db: Database.Database;
let authoritativeStatus: KinescopeStatus;
let getVideo: KinescopeClient["getVideo"];
let client: KinescopeClient;
const uploadInput = { lessonRef: "lesson", title: "Lesson", filename: "lesson.mp4", filesize: 1_048_576, parentId: "folder" };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  authoritativeStatus = "uploading";
  getVideo = vi.fn(async (videoId: string) => ({ id: videoId, status: authoritativeStatus, durationSeconds: 180 }));
  client = {
    initUpload: vi.fn(async () => ({ endpoint: "https://tus.example/upload", videoId: "new-video" })),
    getVideo,
  };
});

describe("Kinescope replacement lifecycle", () => {
  it("never replaces a working binding until the new upload is authoritatively ready", async () => {
    db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
      VALUES ('lesson','old-video','before','before')`).run();
    const upload = await startVideoUpload(db, client, uploadInput);
    expect(upload).toEqual({ uploadSessionId: expect.any(String), endpoint: "https://tus.example/upload" });

    authoritativeStatus = "processing";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "processing", rawBody: "processing" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings").get()).toEqual({ active_video_id: "old-video" });

    authoritativeStatus = "error";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "error", rawBody: "error" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings").get()).toEqual({ active_video_id: "old-video" });
  });

  it("re-reads every webhook, dedupes its content key, and atomically activates READY", async () => {
    await startVideoUpload(db, client, uploadInput);
    authoritativeStatus = "done";
    const first = await observeKinescopeStatus(db, client, { videoId: "new-video", status: "done", rawBody: "done-one" });
    const duplicate = await observeKinescopeStatus(db, client, { videoId: "new-video", status: "done", rawBody: "done-two" });
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(getVideo).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT active_video_id,duration_seconds FROM lesson_video_bindings").get())
      .toEqual({ active_video_id: "new-video", duration_seconds: 180 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM kinescope_webhook_events").get()).toEqual({ count: 1 });
  });

  it("reports the stored terminal state when a later authoritative read regresses", async () => {
    await startVideoUpload(db, client, uploadInput);
    authoritativeStatus = "done";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "done", rawBody: "done" });
    authoritativeStatus = "processing";
    const regressed = await observeKinescopeStatus(db, client, { videoId: "new-video", status: "processing", rawBody: "late-processing" });
    expect(regressed.status).toBe("READY");
    expect(db.prepare("SELECT status FROM video_upload_sessions").get()).toEqual({ status: "READY" });
  });

  it("uses authoritative polling when a webhook was missed", async () => {
    const upload = await startVideoUpload(db, client, uploadInput);
    authoritativeStatus = "done";
    expect(await pollKinescopeUpload(db, client, upload.uploadSessionId)).toEqual({ status: "READY", durationSeconds: 180 });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get()).toEqual({ active_video_id: "new-video" });
  });
});

describe("Kinescope Tus initialisation", () => {
  it("sends the documented init request with the selected file's metadata", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({
      data: { id: "new-video", endpoint: "https://uploader.kinescope.io/v2/upload/abc" },
    }));
    const http = new HttpKinescopeClient("api-token", request);
    await expect(http.initUpload({ title: "Lesson", parentId: "folder", filename: "lesson.mp4", filesize: 1_048_576 }))
      .resolves.toEqual({ endpoint: "https://uploader.kinescope.io/v2/upload/abc", videoId: "new-video" });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://uploader.kinescope.io/v2/init");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: "Bearer api-token", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "video", parent_id: "folder", title: "Lesson", filename: "lesson.mp4", filesize: 1_048_576,
    });
  });

  it("rejects missing or malformed file metadata before calling Kinescope", async () => {
    for (const invalid of [
      { filename: "", filesize: 1 },
      { filename: "dir/lesson.mp4", filesize: 1 },
      { filename: "lesson.mp4", filesize: 0 },
      { filename: "lesson.mp4", filesize: 1.5 },
      { filename: "lesson.mp4", filesize: undefined },
    ]) {
      await expect(startVideoUpload(db, client, { ...uploadInput, ...invalid } as typeof uploadInput)).rejects.toThrow(/^VIDEO_UPLOAD_/);
    }
    expect(client.initUpload).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM video_upload_sessions").get()).toEqual({ count: 0 });
  });
});
