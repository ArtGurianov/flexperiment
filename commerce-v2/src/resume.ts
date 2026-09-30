import type Database from "better-sqlite3";

export type ResumeUpdate = {
  readonly customerId: string;
  readonly lessonRef: string;
  readonly seconds: number;
  readonly clientSeq: number;
  readonly clientTs: string;
};

export function saveResumePosition(db: Database.Database, update: ResumeUpdate, now = new Date().toISOString()) {
  if (!Number.isInteger(update.seconds) || update.seconds < 0) throw new Error("INVALID_RESUME_SECONDS");
  if (!Number.isInteger(update.clientSeq) || update.clientSeq < 0) throw new Error("INVALID_CLIENT_SEQUENCE");
  if (!Number.isFinite(Date.parse(update.clientTs))) throw new Error("INVALID_CLIENT_TIMESTAMP");
  const result = db.prepare(`INSERT INTO lesson_resume_positions(customer_id,lesson_ref,seconds,client_seq,client_ts,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(customer_id,lesson_ref) DO UPDATE SET
      seconds=excluded.seconds,client_seq=excluded.client_seq,client_ts=excluded.client_ts,updated_at=excluded.updated_at
    WHERE excluded.client_ts > lesson_resume_positions.client_ts
      OR (excluded.client_ts = lesson_resume_positions.client_ts AND excluded.client_seq > lesson_resume_positions.client_seq)`)
    .run(update.customerId, update.lessonRef, update.seconds, update.clientSeq, update.clientTs, now);
  return { accepted: result.changes === 1 };
}

export function playbackResumeAt(seconds: number, durationSeconds: number | null, endWindowSeconds = 20) {
  if (durationSeconds !== null && durationSeconds - seconds <= endWindowSeconds) return 0;
  return seconds;
}
