import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createRestrictiveOverride, releaseRolledBackOverride, OverrideProofError } from "../src/access-overrides";
import { migrateV2 } from "../src/db";
import { applyCourseManifest, ManifestError, withManifestHash, type CourseManifest } from "../src/manifest";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db); });

const manifest = (version: number, overrides: Partial<Omit<CourseManifest, "contentHash" | "version">> = {}) => withManifestHash({
  courseRef: "course", version, visibility: "LISTED",
  sections: [{ sectionRef: "section", visibility: "LISTED" }],
  lessons: [
    { lessonRef: "preview", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true },
    { lessonRef: "paid", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false },
  ],
  operations: [],
  ...overrides,
});

const createOverride = (operationId = "op", level: "COURSE" | "SECTION" | "LESSON" = "SECTION", ref = "section") =>
  createRestrictiveOverride(db, {
    operationId, courseRef: "course", scope: { level, ref },
    expected: { kind: "EFFECTIVE_VISIBILITY", value: "UNLISTED" },
    deadlineAt: "2026-09-30T01:01:00.000Z", platformEpoch: "epoch-1",
  });

describe("manifest ordering and convergence", () => {
  it("applies once, no-ops the same hash and rejects same-version drift and older versions", () => {
    const first = manifest(1);
    expect(applyCourseManifest(db, first).kind).toBe("APPLIED");
    expect(applyCourseManifest(db, first).kind).toBe("NO_OP");
    expect(() => applyCourseManifest(db, manifest(1, { visibility: "UNLISTED" }))).toThrow(new ManifestError("MANIFEST_VERSION_REJECTED"));
    expect(applyCourseManifest(db, manifest(2)).kind).toBe("APPLIED");
    expect(() => applyCourseManifest(db, first)).toThrow(new ManifestError("MANIFEST_VERSION_REJECTED"));
  });

  it("rejects the whole manifest when a lesson section is missing", () => {
    const invalid = manifest(1, { sections: [] });
    expect(() => applyCourseManifest(db, invalid)).toThrow(new ManifestError("LESSON_SECTION_MISSING"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_course_projection").get()).toEqual({ n: 0 });
  });

  it("rejects ambiguous section and lesson ordering before changing the projection", () => {
    const duplicateSections = manifest(1, {
      sections: [
        { sectionRef: "section", visibility: "LISTED", position: 0 },
        { sectionRef: "other", visibility: "LISTED", position: 0 },
      ],
    });
    expect(() => applyCourseManifest(db, duplicateSections)).toThrow(new ManifestError("DUPLICATE_SECTION_POSITION"));

    const duplicateLessons = manifest(1, {
      lessons: [
        { lessonRef: "preview", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true, position: 0 },
        { lessonRef: "paid", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false, position: 0 },
      ],
    });
    expect(() => applyCourseManifest(db, duplicateLessons)).toThrow(new ManifestError("DUPLICATE_LESSON_POSITION"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_course_projection").get()).toEqual({ n: 0 });
  });

  it("replaces the complete section and lesson projection instead of retaining absent rows", () => {
    applyCourseManifest(db, manifest(1));
    applyCourseManifest(db, manifest(2, { sections: [], lessons: [] }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_section_projection WHERE course_ref='course'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_lesson_projection WHERE course_ref='course'").get()).toEqual({ n: 0 });
  });

  it("rejects an older manifest before it can mutate a pending override", () => {
    createOverride();
    applyCourseManifest(db, manifest(2));
    expect(() => applyCourseManifest(db, manifest(1, {
      sections: [{ sectionRef: "section", visibility: "UNLISTED" }],
      operations: [{ operationId: "op", committedVersion: 1 }],
    }))).toThrow(new ManifestError("MANIFEST_VERSION_REJECTED"));
    expect(db.prepare("SELECT state,attention_reason FROM access_overrides WHERE operation_id='op'").get())
      .toEqual({ state: "PENDING", attention_reason: null });
  });
});

describe("restrictive override resolution", () => {
  it("finalizes a section override by effective visibility while lesson rows remain listed", () => {
    createOverride();
    const restricted = manifest(1, {
      sections: [{ sectionRef: "section", visibility: "UNLISTED" }],
      operations: [{ operationId: "op", committedVersion: 1 }],
    });
    expect(applyCourseManifest(db, restricted).finalized).toEqual(["op"]);
    expect(db.prepare("SELECT state FROM access_overrides WHERE operation_id='op'").get()).toEqual({ state: "FINALIZED" });
    expect(db.prepare("SELECT DISTINCT visibility FROM catalog_lesson_projection").all()).toEqual([{ visibility: "LISTED" }]);
  });

  it("supersedes only with a newer committed manifest", () => {
    createOverride();
    applyCourseManifest(db, manifest(1));
    const relisted = manifest(2, { operations: [{ operationId: "op", committedVersion: 1 }] });
    expect(applyCourseManifest(db, relisted).superseded).toEqual(["op"]);
    expect(db.prepare("SELECT state FROM access_overrides WHERE operation_id='op'").get()).toEqual({ state: "SUPERSEDED" });
    const audit = db.prepare("SELECT action,evidence_json FROM audit_log WHERE subject_ref='op'").get() as { action: string; evidence_json: string };
    expect(audit.action).toBe("ACCESS_OVERRIDE_SUPERSEDED");
    expect(JSON.parse(audit.evidence_json)).toMatchObject({
      committedVersion: 1,
      resolvingManifestVersion: 2,
      resolvingManifestHash: relisted.contentHash,
    });
    expect(() => applyCourseManifest(db, manifest(1, {
      sections: [{ sectionRef: "section", visibility: "UNLISTED" }],
      operations: [{ operationId: "op", committedVersion: 1 }],
    }))).toThrow(new ManifestError("MANIFEST_VERSION_REJECTED"));
    expect(db.prepare("SELECT state FROM access_overrides WHERE operation_id='op'").get()).toEqual({ state: "SUPERSEDED" });
  });

  it("rejects an inconsistent manifest at the committed version and keeps enforcement", () => {
    createOverride();
    const inconsistent = manifest(1, { operations: [{ operationId: "op", committedVersion: 1 }] });
    expect(() => applyCourseManifest(db, inconsistent)).toThrow(new ManifestError("COMMITTED_RESTRICTION_ABSENT"));
    expect(db.prepare("SELECT state, attention_reason FROM access_overrides WHERE operation_id='op'").get())
      .toEqual({ state: "PENDING", attention_reason: "COMMITTED_RESTRICTION_ABSENT" });
  });

  it("never releases a rollback from timeout alone", () => {
    createOverride();
    expect(() => releaseRolledBackOverride(db, "op", {
      checkedAt: "2026-09-30T02:00:00.000Z", currentPlatformEpoch: "epoch-1",
      committedRecordExists: false, operationInFlight: false, transactionEnded: false,
    })).toThrow(new OverrideProofError("TRANSACTION_END_NOT_PROVEN"));
    releaseRolledBackOverride(db, "op", {
      checkedAt: "2026-09-30T02:00:00.000Z", currentPlatformEpoch: "epoch-1",
      committedRecordExists: false, operationInFlight: false, transactionEnded: true,
    });
    expect(db.prepare("SELECT state FROM access_overrides WHERE operation_id='op'").get()).toEqual({ state: "RELEASED_ROLLED_BACK" });
  });

  it("refuses rollback release while the platform operation may still commit", () => {
    createOverride();
    expect(() => releaseRolledBackOverride(db, "op", {
      checkedAt: "2026-09-30T02:00:00.000Z", currentPlatformEpoch: "epoch-1",
      committedRecordExists: false, operationInFlight: true, transactionEnded: true,
    })).toThrow(new OverrideProofError("OPERATION_STILL_IN_FLIGHT"));
    expect(db.prepare("SELECT state FROM access_overrides WHERE operation_id='op'").get()).toEqual({ state: "PENDING" });
  });

  it("flags a commit that lands after rollback release while applying its restriction", () => {
    createOverride();
    releaseRolledBackOverride(db, "op", {
      checkedAt: "2026-09-30T02:00:00.000Z", currentPlatformEpoch: "epoch-2",
      committedRecordExists: false, operationInFlight: false, transactionEnded: true,
    });
    const restricted = manifest(1, {
      sections: [{ sectionRef: "section", visibility: "UNLISTED" }],
      operations: [{ operationId: "op", committedVersion: 1 }],
    });
    expect(applyCourseManifest(db, restricted).kind).toBe("APPLIED");
    expect(db.prepare(`SELECT state,attention_reason,committed_version,resolving_manifest_version
      FROM access_overrides WHERE operation_id='op'`).get()).toEqual({
      state: "RELEASED_ROLLED_BACK",
      attention_reason: "COMMIT_AFTER_ROLLBACK_RELEASE",
      committed_version: 1,
      resolving_manifest_version: 1,
    });
    expect(db.prepare("SELECT visibility FROM catalog_section_projection WHERE section_ref='section'").get())
      .toEqual({ visibility: "UNLISTED" });
    expect(db.prepare("SELECT action FROM audit_log WHERE subject_ref='op'").get())
      .toEqual({ action: "ACCESS_OVERRIDE_LATE_COMMIT" });
  });
});
