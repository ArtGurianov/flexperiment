import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type Visibility = "LISTED" | "UNLISTED";
export type CourseManifest = {
  readonly courseRef: string;
  readonly version: number;
  readonly contentHash: string;
  readonly visibility: Visibility;
  readonly sections: ReadonlyArray<{ readonly sectionRef: string; readonly visibility: Visibility; readonly position?: number }>;
  readonly lessons: ReadonlyArray<{
    readonly lessonRef: string;
    readonly sectionRef: string;
    readonly everPublished: boolean;
    readonly visibility: Visibility;
    readonly freePreview: boolean;
    readonly position?: number;
  }>;
  readonly operations: ReadonlyArray<{ readonly operationId: string; readonly committedVersion: number }>;
};

export class ManifestError extends Error {
  constructor(readonly code: string) { super(code); }
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, stable(nested)]));
  }
  return value;
};

export function manifestContentHash(manifest: Omit<CourseManifest, "contentHash">): string {
  return createHash("sha256").update(JSON.stringify(stable(manifest))).digest("hex");
}

export function withManifestHash(manifest: Omit<CourseManifest, "contentHash">): CourseManifest {
  return { ...manifest, contentHash: manifestContentHash(manifest) };
}

export function lessonEffectiveVisibility(manifest: CourseManifest, lessonRef: string): Visibility {
  const lesson = manifest.lessons.find((candidate) => candidate.lessonRef === lessonRef);
  if (!lesson) throw new ManifestError("LESSON_NOT_IN_MANIFEST");
  const section = manifest.sections.find((candidate) => candidate.sectionRef === lesson.sectionRef);
  if (!section) throw new ManifestError("LESSON_SECTION_MISSING");
  return manifest.visibility === "LISTED" && section.visibility === "LISTED" && lesson.visibility === "LISTED" ? "LISTED" : "UNLISTED";
}

function validateManifest(manifest: CourseManifest) {
  if (!manifest.courseRef || !Number.isInteger(manifest.version) || manifest.version < 1) throw new ManifestError("MANIFEST_INVALID");
  const expectedHash = manifestContentHash({
    courseRef: manifest.courseRef, version: manifest.version, visibility: manifest.visibility,
    sections: manifest.sections, lessons: manifest.lessons, operations: manifest.operations,
  });
  if (manifest.contentHash !== expectedHash) throw new ManifestError("MANIFEST_HASH_MISMATCH");
  const sectionRefs = new Set<string>();
  for (const section of manifest.sections) {
    if (sectionRefs.has(section.sectionRef)) throw new ManifestError("DUPLICATE_SECTION_REF");
    sectionRefs.add(section.sectionRef);
  }
  const lessonRefs = new Set<string>();
  for (const lesson of manifest.lessons) {
    if (!sectionRefs.has(lesson.sectionRef)) throw new ManifestError("LESSON_SECTION_MISSING");
    if (lessonRefs.has(lesson.lessonRef)) throw new ManifestError("DUPLICATE_LESSON_REF");
    lessonRefs.add(lesson.lessonRef);
  }
  if (new Set(manifest.operations.map(({ operationId }) => operationId)).size !== manifest.operations.length) {
    throw new ManifestError("DUPLICATE_OPERATION_ID");
  }
}

type OverrideRow = {
  operation_id: string;
  course_ref: string;
  scope_level: "COURSE" | "SECTION" | "LESSON";
  scope_ref: string;
  expected_kind: "EFFECTIVE_VISIBILITY" | "FREE_PREVIEW";
  committed_version: number | null;
};

const expectedRestrictionPresent = (manifest: CourseManifest, override: OverrideRow): boolean => {
  if (override.expected_kind === "FREE_PREVIEW") {
    const lesson = manifest.lessons.find(({ lessonRef }) => lessonRef === override.scope_ref);
    return Boolean(lesson && !lesson.freePreview);
  }
  if (override.scope_level === "COURSE") return manifest.courseRef === override.scope_ref && manifest.visibility === "UNLISTED";
  if (override.scope_level === "SECTION") {
    const section = manifest.sections.find(({ sectionRef }) => sectionRef === override.scope_ref);
    if (!section) return false;
    const descendants = manifest.lessons.filter(({ sectionRef }) => sectionRef === override.scope_ref);
    return section.visibility === "UNLISTED" && descendants.every(({ lessonRef }) => lessonEffectiveVisibility(manifest, lessonRef) === "UNLISTED");
  }
  return manifest.lessons.some(({ lessonRef }) => lessonRef === override.scope_ref && lessonEffectiveVisibility(manifest, lessonRef) === "UNLISTED");
};

export type ManifestApplyResult = {
  readonly kind: "APPLIED" | "NO_OP";
  readonly finalized: readonly string[];
  readonly superseded: readonly string[];
  readonly stillOpen: readonly string[];
};

export function applyCourseManifest(db: Database.Database, manifest: CourseManifest, now = new Date().toISOString()): ManifestApplyResult {
  validateManifest(manifest);
  const current = db.prepare("SELECT version, content_hash FROM catalog_course_projection WHERE course_ref = ?").get(manifest.courseRef) as { version: number; content_hash: string } | undefined;
  if (current?.version === manifest.version && current.content_hash === manifest.contentHash) {
    return { kind: "NO_OP", finalized: [], superseded: [], stillOpen: [] };
  }
  if (current && manifest.version <= current.version) throw new ManifestError("MANIFEST_VERSION_REJECTED");

  const decisions: Array<{ operationId: string; outcome: "FINALIZED" | "SUPERSEDED" }> = [];
  for (const operation of manifest.operations) {
    const override = db.prepare("SELECT operation_id, course_ref, scope_level, scope_ref, expected_kind, committed_version FROM access_overrides WHERE operation_id = ? AND state = 'PENDING'").get(operation.operationId) as OverrideRow | undefined;
    if (!override) continue;
    if (override.course_ref !== manifest.courseRef || (override.committed_version !== null && override.committed_version !== operation.committedVersion)) {
      db.prepare("UPDATE access_overrides SET attention_reason = ? WHERE operation_id = ?").run("OPERATION_MANIFEST_MISMATCH", operation.operationId);
      throw new ManifestError("OPERATION_MANIFEST_MISMATCH");
    }
    const present = expectedRestrictionPresent(manifest, override);
    if (present && manifest.version >= operation.committedVersion) decisions.push({ operationId: operation.operationId, outcome: "FINALIZED" });
    else if (!present && manifest.version > operation.committedVersion) decisions.push({ operationId: operation.operationId, outcome: "SUPERSEDED" });
    else {
      db.prepare("UPDATE access_overrides SET attention_reason = ? WHERE operation_id = ?").run("COMMITTED_RESTRICTION_ABSENT", operation.operationId);
      throw new ManifestError("COMMITTED_RESTRICTION_ABSENT");
    }
  }

  const apply = db.transaction(() => {
    db.prepare(`INSERT INTO catalog_course_projection(course_ref,version,content_hash,visibility,last_reconciled_at,applied_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(course_ref) DO UPDATE SET version=excluded.version,content_hash=excluded.content_hash,
      visibility=excluded.visibility,last_reconciled_at=excluded.last_reconciled_at,applied_at=excluded.applied_at`)
      .run(manifest.courseRef, manifest.version, manifest.contentHash, manifest.visibility, now, now);
    const lessonRefs = manifest.lessons.map(({ lessonRef }) => lessonRef);
    const sectionRefs = manifest.sections.map(({ sectionRef }) => sectionRef);
    db.prepare(`DELETE FROM catalog_lesson_projection WHERE course_ref=?${lessonRefs.length > 0
      ? ` AND lesson_ref NOT IN (${lessonRefs.map(() => "?").join(",")})`
      : ""}`).run(manifest.courseRef, ...lessonRefs);
    db.prepare(`DELETE FROM catalog_section_projection WHERE course_ref=?${sectionRefs.length > 0
      ? ` AND section_ref NOT IN (${sectionRefs.map(() => "?").join(",")})`
      : ""}`).run(manifest.courseRef, ...sectionRefs);
    const section = db.prepare(`INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position)
      VALUES (?,?,?,?) ON CONFLICT(section_ref) DO UPDATE SET course_ref=excluded.course_ref,visibility=excluded.visibility,position=excluded.position`);
    manifest.sections.forEach((item, index) => section.run(item.sectionRef, manifest.courseRef, item.visibility, item.position ?? index));
    const lesson = db.prepare(`INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(lesson_ref) DO UPDATE SET course_ref=excluded.course_ref,section_ref=excluded.section_ref,
      ever_published=excluded.ever_published,visibility=excluded.visibility,free_preview=excluded.free_preview,position=excluded.position`);
    manifest.lessons.forEach((item, index) => lesson.run(item.lessonRef, manifest.courseRef, item.sectionRef, Number(item.everPublished), item.visibility, Number(item.freePreview), item.position ?? index));
    for (const decision of decisions) {
      const committedVersion = manifest.operations.find(({ operationId }) => operationId === decision.operationId)!.committedVersion;
      db.prepare(`UPDATE access_overrides SET state=?, committed_version=COALESCE(committed_version,?), resolved_at=?,
        resolving_manifest_version=?, resolving_manifest_hash=?, resolution_evidence_json=? WHERE operation_id=? AND state='PENDING'`)
        .run(decision.outcome, committedVersion, now, manifest.version, manifest.contentHash,
          JSON.stringify({ outcome: decision.outcome, committedVersion }), decision.operationId);
    }
  });
  apply.immediate();
  const stillOpen = (db.prepare("SELECT operation_id FROM access_overrides WHERE course_ref = ? AND state = 'PENDING'").all(manifest.courseRef) as Array<{ operation_id: string }>).map(({ operation_id }) => operation_id);
  return {
    kind: "APPLIED",
    finalized: decisions.filter(({ outcome }) => outcome === "FINALIZED").map(({ operationId }) => operationId),
    superseded: decisions.filter(({ outcome }) => outcome === "SUPERSEDED").map(({ operationId }) => operationId),
    stillOpen,
  };
}
