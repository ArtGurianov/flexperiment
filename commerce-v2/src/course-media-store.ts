import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CourseMediaError, COURSE_MEDIA_VARIANTS, courseMediaSourceKey, courseMediaVariantKey, validateWorkerVariants,
  type AdmittedCourseImage, type PublishedVariant,
} from "./course-media";

/**
 * FLEX-63 metadata store. DDL PROPOSAL for the conditional migration reserve 0041 — registered with the
 * coordinator, NOT yet a numbered migration. Until it is admitted this constant is only applied by tests.
 *
 * Retention: catalogue metadata, kept while the course exists (no personal data; `actor` is the internal
 * Control Room admin id, the same identifier course_editorial_drafts.actor already stores).
 * Erasure: out of scope — no customer data. Restore: metadata comes back with the SQLite backup; image
 * bytes live only in S3 and are re-verified by the worker's read-back, an absent object fails the asset
 * and the public page falls back to no image.
 */
export const COURSE_MEDIA_DDL_PROPOSAL = `
CREATE TABLE course_media_assets (
  asset_id TEXT PRIMARY KEY,
  course_ref TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_mime TEXT NOT NULL CHECK (source_mime IN ('image/jpeg','image/png','image/webp')),
  source_bytes INTEGER NOT NULL CHECK (source_bytes > 0),
  source_width INTEGER NOT NULL CHECK (source_width > 0),
  source_height INTEGER NOT NULL CHECK (source_height > 0),
  alt TEXT NOT NULL CHECK (length(alt) BETWEEN 1 AND 300),
  state TEXT NOT NULL CHECK (state IN ('PENDING','PROCESSING','READY','FAILED','DISCARDED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  variants_json TEXT,
  error_code TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'READY') = (variants_json IS NOT NULL)),
  CHECK ((state = 'PROCESSING') = (lease_token IS NOT NULL)),
  UNIQUE (course_ref, source_sha256)
);
CREATE INDEX course_media_assets_state ON course_media_assets(state, updated_at);
CREATE TABLE course_media_active (
  course_ref TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE REFERENCES course_media_assets(asset_id),
  actor TEXT NOT NULL,
  activated_at TEXT NOT NULL
);`;

export type CourseMediaState = "PENDING" | "PROCESSING" | "READY" | "FAILED" | "DISCARDED";
export type CourseMediaAsset = {
  assetId: string; courseRef: string; sourceSha256: string; sourceMime: string; sourceBytes: number;
  sourceWidth: number; sourceHeight: number; alt: string; state: CourseMediaState; attempts: number;
  variants: PublishedVariant[] | null; errorCode: string | null; createdAt: string; updatedAt: string;
};

type Row = {
  asset_id: string; course_ref: string; source_sha256: string; source_mime: string; source_bytes: number;
  source_width: number; source_height: number; alt: string; state: CourseMediaState; attempts: number;
  lease_token: string | null; lease_expires_at: string | null; variants_json: string | null; error_code: string | null;
  created_at: string; updated_at: string;
};

const toAsset = (row: Row): CourseMediaAsset => ({
  assetId: row.asset_id, courseRef: row.course_ref, sourceSha256: row.source_sha256, sourceMime: row.source_mime,
  sourceBytes: row.source_bytes, sourceWidth: row.source_width, sourceHeight: row.source_height, alt: row.alt,
  state: row.state, attempts: row.attempts,
  variants: row.variants_json ? JSON.parse(row.variants_json) as PublishedVariant[] : null,
  errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
});

const rowById = (db: Database.Database, assetId: string) =>
  db.prepare("SELECT * FROM course_media_assets WHERE asset_id=?").get(assetId) as Row | undefined;

export const getCourseMediaAsset = (db: Database.Database, assetId: string) => {
  const row = rowById(db, assetId);
  return row ? toAsset(row) : null;
};

/** Worker failure codes are an allowlist so a worker cannot write arbitrary text into Commerce. */
export const COURSE_MEDIA_FAILURES = ["SOURCE_MISSING", "SOURCE_MISMATCH", "DECODE_FAILED", "ENCODE_FAILED",
  "UPLOAD_FAILED", "READBACK_MISMATCH", "TIMEOUT"] as const;
export type CourseMediaFailure = typeof COURSE_MEDIA_FAILURES[number];
export const MAX_COURSE_MEDIA_ATTEMPTS = 3;

/**
 * Records an admitted upload. The caller has already stored the source bytes at `courseMediaSourceKey`.
 * Re-uploading the same bytes for the same course is a replay; a FAILED asset gets a fresh attempt budget.
 */
export function registerCourseMediaUpload(
  db: Database.Database, image: AdmittedCourseImage, actor: string, now = new Date().toISOString(),
): { asset: CourseMediaAsset; replayed: boolean; sourceKey: string } {
  if (!actor) throw new CourseMediaError("MEDIA_COURSE_REF_INVALID");
  const sourceKey = courseMediaSourceKey(image.courseRef, image.sourceSha256);
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM course_media_assets WHERE course_ref=? AND source_sha256=?")
      .get(image.courseRef, image.sourceSha256) as Row | undefined;
    if (existing && existing.state !== "FAILED" && existing.state !== "DISCARDED") {
      if (existing.alt !== image.alt) {
        db.prepare("UPDATE course_media_assets SET alt=?,updated_at=? WHERE asset_id=?").run(image.alt, now, existing.asset_id);
      }
      return { asset: toAsset(rowById(db, existing.asset_id)!), replayed: true, sourceKey };
    }
    if (existing) {
      db.prepare(`UPDATE course_media_assets SET state='PENDING',attempts=0,error_code=NULL,lease_token=NULL,
        lease_expires_at=NULL,variants_json=NULL,alt=?,actor=?,updated_at=? WHERE asset_id=?`)
        .run(image.alt, actor, now, existing.asset_id);
      return { asset: toAsset(rowById(db, existing.asset_id)!), replayed: false, sourceKey };
    }
    const assetId = randomUUID();
    db.prepare(`INSERT INTO course_media_assets(asset_id,course_ref,source_sha256,source_mime,source_bytes,source_width,
      source_height,alt,state,actor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'PENDING',?,?,?)`)
      .run(assetId, image.courseRef, image.sourceSha256, image.mime, image.bytes, image.width, image.height,
        image.alt, actor, now, now);
    return { asset: toAsset(rowById(db, assetId)!), replayed: false, sourceKey };
  }).immediate();
}

export type CourseMediaJob = {
  assetId: string; leaseToken: string; courseRef: string; sourceSha256: string; sourceKey: string;
  variants: Array<{ name: string; key: string; width: number; height: number }>;
};

/**
 * Hands one PENDING (or lease-expired PROCESSING) asset to a worker. Exceeding the attempt budget
 * fails the asset instead of retrying forever.
 */
export function claimCourseMediaJob(
  db: Database.Database, leaseMs = 5 * 60_000, now = new Date(),
): CourseMediaJob | null {
  const at = now.toISOString();
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM course_media_assets
      WHERE state='PENDING' OR (state='PROCESSING' AND lease_expires_at < ?) ORDER BY updated_at,asset_id LIMIT 1`)
      .get(at) as Row | undefined;
    if (!row) return null;
    if (row.attempts >= MAX_COURSE_MEDIA_ATTEMPTS) {
      db.prepare(`UPDATE course_media_assets SET state='FAILED',error_code='TIMEOUT',lease_token=NULL,lease_expires_at=NULL,
        updated_at=? WHERE asset_id=?`).run(at, row.asset_id);
      return null;
    }
    const leaseToken = randomUUID();
    db.prepare(`UPDATE course_media_assets SET state='PROCESSING',attempts=attempts+1,lease_token=?,lease_expires_at=?,
      updated_at=? WHERE asset_id=?`).run(leaseToken, new Date(now.getTime() + leaseMs).toISOString(), at, row.asset_id);
    return {
      assetId: row.asset_id, leaseToken, courseRef: row.course_ref, sourceSha256: row.source_sha256,
      sourceKey: courseMediaSourceKey(row.course_ref, row.source_sha256),
      variants: COURSE_MEDIA_VARIANTS.map((spec) => ({ ...spec, key: courseMediaVariantKey(row.course_ref, row.source_sha256, spec.name) })),
    };
  }).immediate();
}

export type CourseMediaResult =
  | { readonly outcome: "READY"; readonly variants: unknown }
  | { readonly outcome: "FAILED"; readonly errorCode: unknown };

/**
 * The worker's only write. It must hold the current lease; a READY report repeated with identical
 * variants is an idempotent replay, and nothing here touches the active (published) image.
 */
export function completeCourseMediaJob(
  db: Database.Database, assetId: string, leaseToken: string, result: CourseMediaResult, now = new Date().toISOString(),
): { asset: CourseMediaAsset; replayed: boolean } {
  return db.transaction(() => {
    const row = rowById(db, assetId);
    if (!row) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
    if (result.outcome === "READY") {
      const variants = validateWorkerVariants(row.course_ref, row.source_sha256, result.variants);
      const json = JSON.stringify(variants);
      if (row.state === "READY" && row.variants_json === json) return { asset: toAsset(row), replayed: true };
      if (row.state !== "PROCESSING" || row.lease_token !== leaseToken) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
      db.prepare(`UPDATE course_media_assets SET state='READY',variants_json=?,error_code=NULL,lease_token=NULL,
        lease_expires_at=NULL,updated_at=? WHERE asset_id=?`).run(json, now, assetId);
    } else {
      const code = COURSE_MEDIA_FAILURES.find((item) => item === result.errorCode);
      if (!code) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
      if (row.state === "FAILED" && row.error_code === code) return { asset: toAsset(row), replayed: true };
      if (row.state !== "PROCESSING" || row.lease_token !== leaseToken) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
      // A transient failure goes back to the queue until the attempt budget is spent.
      const terminal = row.attempts >= MAX_COURSE_MEDIA_ATTEMPTS || code === "SOURCE_MISMATCH" || code === "DECODE_FAILED";
      db.prepare(`UPDATE course_media_assets SET state=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?
        WHERE asset_id=?`).run(terminal ? "FAILED" : "PENDING", code, now, assetId);
    }
    return { asset: toAsset(rowById(db, assetId)!), replayed: false };
  }).immediate();
}

/** Owner action: only a verified READY asset may become the course's public image. */
export function activateCourseMedia(db: Database.Database, assetId: string, actor: string, now = new Date().toISOString()) {
  return db.transaction(() => {
    const row = rowById(db, assetId);
    if (!row || row.state !== "READY") throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
    db.prepare(`INSERT INTO course_media_active(course_ref,asset_id,actor,activated_at) VALUES (?,?,?,?)
      ON CONFLICT(course_ref) DO UPDATE SET asset_id=excluded.asset_id,actor=excluded.actor,activated_at=excluded.activated_at`)
      .run(row.course_ref, assetId, actor, now);
    return toAsset(row);
  }).immediate();
}

export function deactivateCourseMedia(db: Database.Database, courseRef: string) {
  db.prepare("DELETE FROM course_media_active WHERE course_ref=?").run(courseRef);
}

export type PublicCourseImage = {
  alt: string; variants: Array<{ name: string; url: string; width: number; height: number }>;
};

/**
 * The public projection the storefront reads. Absent, unverified or failed media yields `null`, and
 * the page renders its text-only fallback. Source keys and asset ids never leave Commerce.
 */
export function publicCourseImage(
  db: Database.Database, courseRef: string, publicURL: (key: string) => string,
): PublicCourseImage | null {
  const row = db.prepare(`SELECT a.* FROM course_media_active m JOIN course_media_assets a ON a.asset_id=m.asset_id
    WHERE m.course_ref=? AND a.state='READY'`).get(courseRef) as Row | undefined;
  if (!row?.variants_json) return null;
  const variants = JSON.parse(row.variants_json) as PublishedVariant[];
  return { alt: row.alt, variants: variants.map(({ name, key, width, height }) => ({ name, url: publicURL(key), width, height })) };
}

/**
 * Objects that no longer back any visible or pending image: FAILED assets, and READY assets that were
 * never or are no longer active, once older than the grace period. The source object is always listed;
 * variant objects only where they may exist. The cleaner deletes them, then calls `discardCourseMedia`.
 */
export function courseMediaOrphans(db: Database.Database, olderThan: string) {
  const rows = db.prepare(`SELECT a.* FROM course_media_assets a LEFT JOIN course_media_active m ON m.asset_id=a.asset_id
    WHERE m.asset_id IS NULL AND a.state IN ('FAILED','READY') AND a.updated_at < ? ORDER BY a.updated_at`)
    .all(olderThan) as Row[];
  return rows.map((row) => ({
    assetId: row.asset_id,
    keys: [courseMediaSourceKey(row.course_ref, row.source_sha256),
      ...COURSE_MEDIA_VARIANTS.map((spec) => courseMediaVariantKey(row.course_ref, row.source_sha256, spec.name))],
  }));
}

export function discardCourseMedia(db: Database.Database, assetId: string, now = new Date().toISOString()) {
  const changed = db.prepare(`UPDATE course_media_assets SET state='DISCARDED',variants_json=NULL,updated_at=?
    WHERE asset_id=? AND state IN ('FAILED','READY') AND asset_id NOT IN (SELECT asset_id FROM course_media_active)`)
    .run(now, assetId).changes;
  return changed === 1;
}
