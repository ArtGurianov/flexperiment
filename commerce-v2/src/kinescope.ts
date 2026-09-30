import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type KinescopeStatus = "pending" | "uploading" | "pre-processing" | "processing" | "aborted" | "done" | "error" | "suspended";
export type VideoState = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";

export type KinescopeVideo = {
  readonly id: string;
  readonly status: KinescopeStatus;
  readonly durationSeconds?: number | null;
};

export interface KinescopeClient {
  initUpload(input: { readonly title: string; readonly parentId: string }): Promise<{ readonly endpoint: string; readonly videoId: string }>;
  getVideo(videoId: string): Promise<KinescopeVideo>;
}

export class HttpKinescopeClient implements KinescopeClient {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async initUpload(input: { title: string; parentId: string }) {
    const response = await this.request("https://uploader.kinescope.io/v2/init", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: input.title, parent_id: input.parentId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { data?: { endpoint?: unknown; id?: unknown; video_id?: unknown } };
    const endpoint = body.data?.endpoint;
    const videoId = body.data?.id ?? body.data?.video_id;
    if (!response.ok || typeof endpoint !== "string" || typeof videoId !== "string") throw new Error("KINESCOPE_UPLOAD_INIT_INVALID");
    return { endpoint, videoId };
  }

  async getVideo(videoId: string) {
    const response = await this.request(`https://api.kinescope.io/v1/videos/${encodeURIComponent(videoId)}`, {
      headers: { authorization: `Bearer ${this.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { data?: { id?: unknown; status?: unknown; duration?: unknown } };
    if (!response.ok || typeof body.data?.id !== "string" || typeof body.data.status !== "string") throw new Error("KINESCOPE_VIDEO_READ_INVALID");
    return {
      id: body.data.id,
      status: body.data.status as KinescopeStatus,
      durationSeconds: typeof body.data.duration === "number" ? Math.round(body.data.duration) : null,
    };
  }
}

const stateForStatus = (status: KinescopeStatus): VideoState => {
  if (status === "done") return "READY";
  if (["aborted", "error", "suspended"].includes(status)) return "FAILED";
  if (["pre-processing", "processing"].includes(status)) return "PROCESSING";
  return "UPLOADING";
};

export async function startVideoUpload(
  db: Database.Database,
  client: KinescopeClient,
  input: { lessonRef: string; title: string; parentId: string },
) {
  const initialized = await client.initUpload({ title: input.title, parentId: input.parentId });
  const id = randomUUID();
  db.prepare(`INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint)
    VALUES (?,?,?,'UPLOADING',?)`).run(id, input.lessonRef, initialized.videoId, initialized.endpoint);
  return { uploadSessionId: id, endpoint: initialized.endpoint };
}

export async function observeKinescopeStatus(
  db: Database.Database,
  client: KinescopeClient,
  notification: { videoId: string; status: KinescopeStatus; rawBody: string },
  now = new Date().toISOString(),
) {
  const authoritative = await client.getVideo(notification.videoId);
  if (authoritative.id !== notification.videoId) throw new Error("KINESCOPE_VIDEO_ID_MISMATCH");
  const contentKey = `${notification.videoId}:${notification.status}`;
  const payloadHash = createHash("sha256").update(notification.rawBody).digest("hex");
  const insert = db.prepare(`INSERT INTO kinescope_webhook_events(content_key,video_id,observed_status,payload_sha256)
    VALUES (?,?,?,?) ON CONFLICT(content_key) DO NOTHING`).run(contentKey, notification.videoId, notification.status, payloadHash);
  const applied = applyAuthoritativeStatus(db, authoritative, now);
  return { duplicate: insert.changes === 0, ...applied };
}

function applyAuthoritativeStatus(db: Database.Database, authoritative: KinescopeVideo, now: string) {
  const session = db.prepare("SELECT id,lesson_ref,status FROM video_upload_sessions WHERE video_id=?").get(authoritative.id) as {
    id: string; lesson_ref: string; status: VideoState;
  } | undefined;
  if (!session) throw new Error("KINESCOPE_UPLOAD_SESSION_NOT_FOUND");
  const next = stateForStatus(authoritative.status);
  const terminal = session.status === "READY" || session.status === "FAILED";
  const rank = { UPLOADING: 0, PROCESSING: 1, READY: 2, FAILED: 2 } as const;
  if (!terminal && rank[next] >= rank[session.status]) {
    const run = db.transaction(() => {
      db.prepare(`UPDATE video_upload_sessions SET status=?,error_code=?,updated_at=? WHERE id=?`)
        .run(next, next === "FAILED" ? authoritative.status.toUpperCase() : null, now, session.id);
      if (next === "READY") {
        db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at)
          VALUES (?,?,?,?,?) ON CONFLICT(lesson_ref) DO UPDATE SET active_video_id=excluded.active_video_id,
          duration_seconds=excluded.duration_seconds,bound_at=excluded.bound_at,updated_at=excluded.updated_at`)
          .run(session.lesson_ref, authoritative.id, authoritative.durationSeconds ?? null, now, now);
      }
    });
    run.immediate();
  }
  const applied = db.prepare("SELECT status FROM video_upload_sessions WHERE id=?").get(session.id) as { status: VideoState };
  return { status: applied.status, durationSeconds: authoritative.durationSeconds ?? null };
}

export async function pollKinescopeUpload(
  db: Database.Database,
  client: KinescopeClient,
  uploadSessionId: string,
  now = new Date().toISOString(),
) {
  const session = db.prepare("SELECT video_id,status FROM video_upload_sessions WHERE id=?").get(uploadSessionId) as {
    video_id: string; status: VideoState;
  } | undefined;
  if (!session) throw new Error("KINESCOPE_UPLOAD_SESSION_NOT_FOUND");
  if (session.status === "READY" || session.status === "FAILED") {
    const duration = db.prepare("SELECT duration_seconds FROM lesson_video_bindings WHERE lesson_ref=(SELECT lesson_ref FROM video_upload_sessions WHERE id=?)")
      .get(uploadSessionId) as { duration_seconds: number | null } | undefined;
    return { status: session.status, durationSeconds: duration?.duration_seconds ?? null };
  }
  const authoritative = await client.getVideo(session.video_id);
  if (authoritative.id !== session.video_id) throw new Error("KINESCOPE_VIDEO_ID_MISMATCH");
  return applyAuthoritativeStatus(db, authoritative, now);
}
