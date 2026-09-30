import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { observeKinescopeStatus, pollKinescopeUpload, startVideoUpload, type KinescopeClient, type KinescopeStatus } from "../src/kinescope";

let db: Database.Database;
let authoritativeStatus: KinescopeStatus;
let getVideo: KinescopeClient["getVideo"];
let client: KinescopeClient;

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
    const upload = await startVideoUpload(db, client, { lessonRef: "lesson", title: "Lesson", parentId: "folder" });
    expect(upload).toEqual({ uploadSessionId: expect.any(String), endpoint: "https://tus.example/upload" });

    authoritativeStatus = "processing";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "processing", rawBody: "processing" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings").get()).toEqual({ active_video_id: "old-video" });

    authoritativeStatus = "error";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "error", rawBody: "error" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings").get()).toEqual({ active_video_id: "old-video" });
  });

  it("re-reads every webhook, dedupes its content key, and atomically activates READY", async () => {
    await startVideoUpload(db, client, { lessonRef: "lesson", title: "Lesson", parentId: "folder" });
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
    await startVideoUpload(db, client, { lessonRef: "lesson", title: "Lesson", parentId: "folder" });
    authoritativeStatus = "done";
    await observeKinescopeStatus(db, client, { videoId: "new-video", status: "done", rawBody: "done" });
    authoritativeStatus = "processing";
    const regressed = await observeKinescopeStatus(db, client, { videoId: "new-video", status: "processing", rawBody: "late-processing" });
    expect(regressed.status).toBe("READY");
    expect(db.prepare("SELECT status FROM video_upload_sessions").get()).toEqual({ status: "READY" });
  });

  it("uses authoritative polling when a webhook was missed", async () => {
    const upload = await startVideoUpload(db, client, { lessonRef: "lesson", title: "Lesson", parentId: "folder" });
    authoritativeStatus = "done";
    expect(await pollKinescopeUpload(db, client, upload.uploadSessionId)).toEqual({ status: "READY", durationSeconds: 180 });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get()).toEqual({ active_video_id: "new-video" });
  });
});
