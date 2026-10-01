import type Database from "better-sqlite3";

export type PlaybackAccessEventType =
  | "GRANT_ALLOWED"
  | "GRANT_DENIED"
  | "GRANT_RATE_LIMITED"
  | "DRM_ALLOWED"
  | "DRM_DENIED"
  | "DRM_TOKEN_INVALID";

export function recordPlaybackAccessEvent(db: Database.Database, input: {
  customerId?: string;
  lessonRef?: string;
  videoId?: string;
  eventType: PlaybackAccessEventType;
  reason: string;
  occurredAt: string;
}) {
  db.prepare(`INSERT INTO playback_access_events(customer_id,lesson_ref,video_id,event_type,reason,occurred_at)
    VALUES (?,?,?,?,?,?)`).run(
    input.customerId ?? null,
    input.lessonRef ?? null,
    input.videoId ?? null,
    input.eventType,
    input.reason,
    input.occurredAt,
  );
}

export function playbackAccessSummary(db: Database.Database, since: string) {
  const rows = db.prepare(`SELECT event_type,COUNT(*) AS count FROM playback_access_events
    WHERE occurred_at>=? GROUP BY event_type`).all(since) as Array<{ event_type: PlaybackAccessEventType; count: number }>;
  const count = (type: PlaybackAccessEventType) => rows.find((row) => row.event_type === type)?.count ?? 0;
  return {
    allowed: count("GRANT_ALLOWED") + count("DRM_ALLOWED"),
    denied: count("GRANT_DENIED") + count("DRM_DENIED"),
    rateLimited: count("GRANT_RATE_LIMITED"),
    invalidToken: count("DRM_TOKEN_INVALID"),
  };
}
