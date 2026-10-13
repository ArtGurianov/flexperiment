import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { withdrawProduct } from "./catalog-control";

const ref = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/);
const slug = z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const visibility = z.enum(["LISTED", "UNLISTED"]);
const text = z.string().min(1).max(240);
const richText = z.object({ root: z.object({ type: z.literal("root"), version: z.number().int().positive(), children: z.array(z.unknown()).max(5000) }).passthrough() }).passthrough();
const seo = z.object({ title: z.string().max(240).optional(), description: z.string().max(1000).optional() }).strict();
const lesson = z.object({
  lessonRef: ref, title: text, slug, sectionRef: ref, position: z.number().int().min(0),
  visibility, freePreview: z.boolean(), description: richText.nullable().optional(), seo: seo.optional(),
}).strict();
const section = z.object({ sectionRef: ref, title: text, position: z.number().int().min(0), visibility }).strict();
export const editorialDocumentSchema = z.object({
  courseRef: ref, title: text, slug, summary: z.string().max(2000),
  visibility, description: richText.nullable().optional(), seo: seo.optional(),
  sections: z.array(section).min(1).max(200), lessons: z.array(lesson).min(1).max(2000),
}).strict();
export type EditorialDocument = z.infer<typeof editorialDocumentSchema>;
export type SaveDraftInput = { document: EditorialDocument; expectedRevision: number; actor: string };
export type PublishInput = { courseRef: string; expectedRevision: number; expectedPublishedVersion: number; idempotencyKey: string; actor: string };
export type PublicationResult = { courseRef: string; version: number; draftRevision: number; contentHash: string; visibility: "LISTED" | "UNLISTED"; replayed: boolean };

export class EditorialError extends Error {
  constructor(readonly code: string) { super(code); }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const requireUnique = (items: readonly string[], code: string) => {
  if (new Set(items).size !== items.length) throw new EditorialError(code);
};
function validateLexicalTree(value: unknown) {
  if (value === null || value === undefined) return;
  const root = value as { root: unknown };
  const visit = (node: unknown, depth: number, budget: { remaining: number }) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 2 || --budget.remaining < 0) {
      throw new EditorialError("LEXICAL_TREE_INVALID");
    }
    const item = node as { type?: unknown; version?: unknown; children?: unknown; text?: unknown; style?: unknown };
    if (typeof item.type !== "string" || !item.type || !Number.isSafeInteger(item.version) || Number(item.version) < 1
      || (item.text !== undefined && typeof item.text !== "string")) throw new EditorialError("LEXICAL_TREE_INVALID");
    const allowed = depth === 0 ? "root" : depth === 1 ? "paragraph" : null;
    if (allowed ? item.type !== allowed || !Array.isArray(item.children) || item.text !== undefined
      : !["text", "linebreak"].includes(item.type) || item.children !== undefined
        || (item.type === "text" && (typeof item.text !== "string" || item.style !== undefined && item.style !== ""))
        || (item.type === "linebreak" && item.text !== undefined)) throw new EditorialError("LEXICAL_TREE_INVALID");
    if (Array.isArray(item.children)) for (const child of item.children) visit(child, depth + 1, budget);
  };
  visit(root.root, 0, { remaining: 5000 });
}
export function validateEditorialDocument(input: unknown): { document: EditorialDocument; json: string } {
  const parsed = editorialDocumentSchema.safeParse(input);
  if (!parsed.success) throw new EditorialError("EDITORIAL_DOCUMENT_INVALID");
  const document = parsed.data;
  validateLexicalTree(document.description);
  for (const item of document.lessons) validateLexicalTree(item.description);
  const json = JSON.stringify(document);
  if (Buffer.byteLength(json, "utf8") > 262144) throw new EditorialError("EDITORIAL_DOCUMENT_TOO_LARGE");
  requireUnique(document.sections.map(item => item.sectionRef), "DUPLICATE_SECTION_REF");
  requireUnique(document.sections.map(item => String(item.position)), "DUPLICATE_SECTION_POSITION");
  requireUnique(document.lessons.map(item => item.lessonRef), "DUPLICATE_LESSON_REF");
  requireUnique(document.lessons.map(item => item.slug), "DUPLICATE_LESSON_SLUG");
  const sections = new Set(document.sections.map(item => item.sectionRef));
  for (const item of document.lessons) if (!sections.has(item.sectionRef)) throw new EditorialError("LESSON_SECTION_MISSING");
  requireUnique(document.lessons.map(item => `${item.sectionRef}:${item.position}`), "DUPLICATE_LESSON_POSITION");
  return { document, json };
}

export function getEditorialDraft(db: Database.Database, courseRef: string) {
  const row = db.prepare("SELECT revision,document_json,actor,created_at,updated_at FROM course_editorial_drafts WHERE course_ref=?")
    .get(courseRef) as { revision: number; document_json: string; actor: string; created_at: string; updated_at: string } | undefined;
  return row ? { courseRef, revision: row.revision, document: JSON.parse(row.document_json) as EditorialDocument,
    actor: row.actor, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function saveEditorialDraft(db: Database.Database, input: SaveDraftInput, now = new Date().toISOString()) {
  const { document, json } = validateEditorialDocument(input.document);
  if (!input.actor || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new EditorialError("EDITORIAL_COMMAND_INVALID");
  const save = db.transaction(() => {
    const existing = db.prepare("SELECT revision FROM course_editorial_drafts WHERE course_ref=?").get(document.courseRef) as { revision: number } | undefined;
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw new EditorialError("DRAFT_REVISION_CONFLICT");
    const published = db.prepare("SELECT authoring_source FROM catalog_course_projection WHERE course_ref=?").get(document.courseRef) as { authoring_source: string } | undefined;
    if (published && published.authoring_source !== "COMMERCE_EDITORIAL") throw new EditorialError("LEGACY_COURSE_OWNED");
    const revision = input.expectedRevision + 1;
    db.prepare(`INSERT INTO course_editorial_drafts(course_ref,revision,document_json,actor,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(course_ref) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,
        actor=excluded.actor,updated_at=excluded.updated_at`)
      .run(document.courseRef, revision, json, input.actor, now, now);
    return { courseRef: document.courseRef, revision };
  });
  return save.immediate();
}

function publishedSnapshot(db: Database.Database, courseRef: string) {
  // Exact serialized bytes are the immutable version's SHA-256 preimage.
  // The digest itself must stay outside the snapshot to avoid self-reference.
  const course = db.prepare(`SELECT course_ref,version,title,slug,summary,description_json,seo_json,visibility,
    editorial_requested_visibility,editorial_restriction
    FROM catalog_course_projection WHERE course_ref=?`).get(courseRef);
  const sections = db.prepare(`SELECT section_ref,course_ref,title,position,visibility FROM catalog_section_projection
    WHERE course_ref=? ORDER BY position,section_ref`).all(courseRef);
  const lessons = db.prepare(`SELECT lesson_ref,course_ref,section_ref,title,slug,position,visibility,free_preview,ever_published,
    description_json,seo_json FROM catalog_lesson_projection WHERE course_ref=? ORDER BY section_ref,position,lesson_ref`).all(courseRef);
  return JSON.stringify({ course, sections, lessons });
}

export function getEditorialPublished(db: Database.Database, courseRef: string) {
  const read = db.transaction(() => {
    const row = db.prepare("SELECT authoring_source FROM catalog_course_projection WHERE course_ref=?").get(courseRef) as { authoring_source: string } | undefined;
    if (row?.authoring_source !== "COMMERCE_EDITORIAL") return null;
    return JSON.parse(publishedSnapshot(db, courseRef)) as Record<string, unknown>;
  });
  return read.deferred();
}

export function publishEditorialDraft(db: Database.Database, input: PublishInput, now = new Date().toISOString()): PublicationResult {
  if (!input.actor || !ref.safeParse(input.courseRef).success || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !Number.isSafeInteger(input.expectedPublishedVersion) || input.expectedPublishedVersion < 0
    || !input.idempotencyKey || input.idempotencyKey.length > 120) throw new EditorialError("EDITORIAL_COMMAND_INVALID");
  const requestHash = sha(JSON.stringify({ courseRef: input.courseRef, expectedRevision: input.expectedRevision,
    expectedPublishedVersion: input.expectedPublishedVersion, idempotencyKey: input.idempotencyKey }));
  const publish = db.transaction(() => {
    const previous = db.prepare("SELECT request_hash,result_json FROM course_editorial_publish_commands WHERE course_ref=? AND idempotency_key=?")
      .get(input.courseRef, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new EditorialError("IDEMPOTENCY_KEY_REUSED");
      return { ...(JSON.parse(previous.result_json) as PublicationResult), replayed: true };
    }
    const draft = db.prepare("SELECT revision,document_json FROM course_editorial_drafts WHERE course_ref=?")
      .get(input.courseRef) as { revision: number; document_json: string } | undefined;
    if (!draft || draft.revision !== input.expectedRevision) throw new EditorialError("DRAFT_REVISION_CONFLICT");
    const { document, json } = validateEditorialDocument(JSON.parse(draft.document_json));
    if (document.courseRef !== input.courseRef) throw new EditorialError("COURSE_REF_MISMATCH");
    const current = db.prepare("SELECT version,authoring_source,slug,editorial_restriction FROM catalog_course_projection WHERE course_ref=?")
      .get(input.courseRef) as { version: number; authoring_source: string; slug: string | null; editorial_restriction: string } | undefined;
    if ((current?.version ?? 0) !== input.expectedPublishedVersion) throw new EditorialError("PUBLISHED_VERSION_CONFLICT");
    if (current && current.authoring_source !== "COMMERCE_EDITORIAL") throw new EditorialError("LEGACY_COURSE_OWNED");
    if (current?.slug && current.slug !== document.slug) throw new EditorialError("COURSE_SLUG_IMMUTABLE");
    const product = db.prepare("SELECT id,access_model,withdrawn_at FROM products WHERE kind='ONLINE_COURSE' AND course_ref=?")
      .get(input.courseRef) as { id: string; access_model: string; withdrawn_at: string | null } | undefined;
    if (!product || product.withdrawn_at) throw new EditorialError("ACTIVE_COURSE_PRODUCT_REQUIRED");
    if (product.access_model === "PAID" && !db.prepare("SELECT 1 FROM offers WHERE product_id=?").get(product.id))
      throw new EditorialError("PAID_COURSE_OFFER_REQUIRED");
    for (const item of document.sections) {
      const old = db.prepare("SELECT course_ref FROM catalog_section_projection WHERE section_ref=?").get(item.sectionRef) as { course_ref: string } | undefined;
      if (old && old.course_ref !== input.courseRef) throw new EditorialError("SECTION_REF_IMMUTABLE");
    }
    for (const item of document.lessons) {
      const old = db.prepare("SELECT course_ref,section_ref,slug FROM catalog_lesson_projection WHERE lesson_ref=?")
        .get(item.lessonRef) as { course_ref: string; section_ref: string; slug: string | null } | undefined;
      if (old && (old.course_ref !== input.courseRef || old.section_ref !== item.sectionRef || old.slug !== item.slug))
        throw new EditorialError("LESSON_IDENTITY_IMMUTABLE");
    }
    const version = input.expectedPublishedVersion + 1;
    const effectiveVisibility = current?.editorial_restriction && current.editorial_restriction !== "NONE"
      ? "UNLISTED" : document.visibility;
    const temporaryHash = sha(json);
    db.prepare(`INSERT INTO catalog_course_projection(course_ref,version,content_hash,state_hash,visibility,last_reconciled_at,applied_at,
      authoring_source,title,slug,summary,description_json,seo_json,editorial_requested_visibility,editorial_restriction)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(course_ref) DO UPDATE SET version=excluded.version,content_hash=excluded.content_hash,state_hash=excluded.state_hash,
      visibility=excluded.visibility,last_reconciled_at=excluded.last_reconciled_at,applied_at=excluded.applied_at,
      title=excluded.title,summary=excluded.summary,description_json=excluded.description_json,seo_json=excluded.seo_json,
      editorial_requested_visibility=excluded.editorial_requested_visibility`)
      .run(input.courseRef, version, temporaryHash, temporaryHash, effectiveVisibility, now, now, "COMMERCE_EDITORIAL",
        document.title, document.slug, document.summary, JSON.stringify(document.description ?? null), JSON.stringify(document.seo ?? null),
        document.visibility, current?.editorial_restriction ?? "NONE");
    const sectionRefs = document.sections.map(item => item.sectionRef);
    const lessonRefs = document.lessons.map(item => item.lessonRef);
    db.prepare(`UPDATE catalog_lesson_projection SET visibility='UNLISTED',free_preview=0 WHERE course_ref=? AND lesson_ref NOT IN (${lessonRefs.map(() => "?").join(",")})`)
      .run(input.courseRef, ...lessonRefs);
    db.prepare(`UPDATE catalog_section_projection SET visibility='UNLISTED' WHERE course_ref=? AND section_ref NOT IN (${sectionRefs.map(() => "?").join(",")})`)
      .run(input.courseRef, ...sectionRefs);
    const putSection = db.prepare(`INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position,title) VALUES (?,?,?,?,?)
      ON CONFLICT(section_ref) DO UPDATE SET visibility=excluded.visibility,position=excluded.position,title=excluded.title`);
    for (const item of document.sections) putSection.run(item.sectionRef, input.courseRef, item.visibility, item.position, item.title);
    const putLesson = db.prepare(`INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position,
      title,slug,description_json,seo_json) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lesson_ref) DO UPDATE SET
      visibility=excluded.visibility,free_preview=excluded.free_preview,position=excluded.position,title=excluded.title,
      description_json=excluded.description_json,seo_json=excluded.seo_json`);
    for (const item of document.lessons) putLesson.run(item.lessonRef, input.courseRef, item.sectionRef, 1, item.visibility,
      Number(item.freePreview), item.position, item.title, item.slug, JSON.stringify(item.description ?? null), JSON.stringify(item.seo ?? null));
    const snapshot = publishedSnapshot(db, input.courseRef);
    if (Buffer.byteLength(snapshot, "utf8") > 1_048_576) throw new EditorialError("PUBLISHED_GRAPH_TOO_LARGE");
    const contentHash = sha(snapshot);
    db.prepare("UPDATE catalog_course_projection SET content_hash=?,state_hash=? WHERE course_ref=?")
      .run(contentHash, contentHash, input.courseRef);
    db.prepare(`INSERT INTO course_editorial_versions(course_ref,version,draft_revision,document_json,content_hash,actor,published_at)
      VALUES (?,?,?,?,?,?,?)`).run(input.courseRef, version, draft.revision, snapshot, contentHash, input.actor, now);
    const result: PublicationResult = { courseRef: input.courseRef, version, draftRevision: draft.revision,
      contentHash, visibility: effectiveVisibility, replayed: false };
    db.prepare(`INSERT INTO course_editorial_publish_commands(course_ref,idempotency_key,request_hash,result_json,created_at)
      VALUES (?,?,?,?,?)`).run(input.courseRef, input.idempotencyKey, requestHash, JSON.stringify(result), now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.actor, "COURSE_EDITORIAL_PUBLISHED", "course", input.courseRef,
        JSON.stringify({ version, draftRevision: draft.revision, contentHash, idempotencyKey: input.idempotencyKey }), now);
    return result;
  });
  return publish.immediate();
}

export type RestrictCourseInput = {
  courseRef: string; expectedPublishedVersion: number; idempotencyKey: string; actor: string;
  withdrawal?: { productRef: string; expectedProductVersion: number; reason: string; termsRef: string };
};

/** Emergency restrictive change independent of a pending editorial draft. */
export function restrictEditorialCourse(db: Database.Database, input: RestrictCourseInput, now = new Date().toISOString()) {
  if (!ref.safeParse(input.courseRef).success || !input.actor || !input.idempotencyKey || input.idempotencyKey.length > 120
    || !Number.isSafeInteger(input.expectedPublishedVersion) || input.expectedPublishedVersion < 1) {
    throw new EditorialError("EDITORIAL_COMMAND_INVALID");
  }
  const requestHash = sha(JSON.stringify({ courseRef: input.courseRef, expectedPublishedVersion: input.expectedPublishedVersion,
    idempotencyKey: input.idempotencyKey, withdrawal: input.withdrawal ? {
      productRef: input.withdrawal.productRef, expectedProductVersion: input.withdrawal.expectedProductVersion,
      reason: input.withdrawal.reason, termsRef: input.withdrawal.termsRef,
    } : null }));
  const restrict = db.transaction(() => {
    const previous = db.prepare("SELECT request_hash,result_json FROM course_editorial_publish_commands WHERE course_ref=? AND idempotency_key=?")
      .get(input.courseRef, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new EditorialError("IDEMPOTENCY_KEY_REUSED");
      return { ...(JSON.parse(previous.result_json) as PublicationResult), replayed: true };
    }
    const current = db.prepare("SELECT version,authoring_source,editorial_restriction FROM catalog_course_projection WHERE course_ref=?")
      .get(input.courseRef) as { version: number; authoring_source: string; editorial_restriction: string } | undefined;
    if (!current || current.authoring_source !== "COMMERCE_EDITORIAL") throw new EditorialError("EDITORIAL_COURSE_NOT_FOUND");
    if (current.version !== input.expectedPublishedVersion) throw new EditorialError("PUBLISHED_VERSION_CONFLICT");
    if (input.withdrawal) {
      const product = db.prepare("SELECT product_ref FROM products WHERE kind='ONLINE_COURSE' AND course_ref=?")
        .get(input.courseRef) as { product_ref: string } | undefined;
      if (!product || product.product_ref !== input.withdrawal.productRef) throw new EditorialError("COURSE_PRODUCT_MISMATCH");
      withdrawProduct(db, { productRef: input.withdrawal.productRef, expectedVersion: input.withdrawal.expectedProductVersion,
        reason: input.withdrawal.reason, termsRef: input.withdrawal.termsRef, actor: input.actor }, now);
    }
    const version = current.version + 1;
    const restriction = input.withdrawal || current.editorial_restriction === "WITHDRAWN" ? "WITHDRAWN" : "EMERGENCY_UNLIST";
    db.prepare("UPDATE catalog_course_projection SET version=?,visibility='UNLISTED',editorial_restriction=?,applied_at=? WHERE course_ref=?")
      .run(version, restriction, now, input.courseRef);
    const snapshot = publishedSnapshot(db, input.courseRef);
    if (Buffer.byteLength(snapshot, "utf8") > 1_048_576) throw new EditorialError("PUBLISHED_GRAPH_TOO_LARGE");
    const contentHash = sha(snapshot);
    db.prepare("UPDATE catalog_course_projection SET content_hash=?,state_hash=? WHERE course_ref=?")
      .run(contentHash, contentHash, input.courseRef);
    const draft = db.prepare("SELECT revision FROM course_editorial_drafts WHERE course_ref=?")
      .get(input.courseRef) as { revision: number } | undefined;
    const draftRevision = draft?.revision ?? 0;
    db.prepare(`INSERT INTO course_editorial_versions(course_ref,version,draft_revision,document_json,content_hash,actor,published_at)
      VALUES (?,?,?,?,?,?,?)`).run(input.courseRef, version, draftRevision, snapshot, contentHash, input.actor, now);
    const result: PublicationResult = { courseRef: input.courseRef, version, draftRevision, contentHash, visibility: "UNLISTED", replayed: false };
    db.prepare(`INSERT INTO course_editorial_publish_commands(course_ref,idempotency_key,request_hash,result_json,created_at)
      VALUES (?,?,?,?,?)`).run(input.courseRef, input.idempotencyKey, requestHash, JSON.stringify(result), now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.actor, input.withdrawal ? "COURSE_EDITORIAL_WITHDRAWN" : "COURSE_EDITORIAL_UNLISTED",
        "course", input.courseRef, JSON.stringify({ version, contentHash, idempotencyKey: input.idempotencyKey,
          productRef: input.withdrawal?.productRef ?? null }), now);
    return result;
  });
  return restrict.immediate();
}

export type RelistCourseInput = {
  courseRef: string; expectedPublishedVersion: number; idempotencyKey: string; reason: string; actor: string;
};

/** Explicitly releases an emergency unlist for the current published graph. */
export function relistEditorialCourse(db: Database.Database, input: RelistCourseInput, now = new Date().toISOString()) {
  if (!ref.safeParse(input.courseRef).success || !input.actor || !input.idempotencyKey || input.idempotencyKey.length > 120
    || !Number.isSafeInteger(input.expectedPublishedVersion) || input.expectedPublishedVersion < 1
    || !input.reason?.trim() || input.reason.length > 1000) throw new EditorialError("EDITORIAL_COMMAND_INVALID");
  const requestHash = sha(JSON.stringify({ operation: "RELIST", courseRef: input.courseRef,
    expectedPublishedVersion: input.expectedPublishedVersion, idempotencyKey: input.idempotencyKey, reason: input.reason.trim() }));
  const relist = db.transaction(() => {
    const previous = db.prepare("SELECT request_hash,result_json FROM course_editorial_publish_commands WHERE course_ref=? AND idempotency_key=?")
      .get(input.courseRef, input.idempotencyKey) as { request_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new EditorialError("IDEMPOTENCY_KEY_REUSED");
      return { ...(JSON.parse(previous.result_json) as PublicationResult), replayed: true };
    }
    const current = db.prepare(`SELECT course.version,course.authoring_source,course.editorial_restriction,
      course.editorial_requested_visibility,product.withdrawn_at FROM catalog_course_projection course
      LEFT JOIN products product ON product.course_ref=course.course_ref AND product.kind='ONLINE_COURSE'
      WHERE course.course_ref=?`).get(input.courseRef) as { version: number; authoring_source: string;
        editorial_restriction: string; editorial_requested_visibility: string | null; withdrawn_at: string | null } | undefined;
    if (!current || current.authoring_source !== "COMMERCE_EDITORIAL") throw new EditorialError("EDITORIAL_COURSE_NOT_FOUND");
    if (current.version !== input.expectedPublishedVersion) throw new EditorialError("PUBLISHED_VERSION_CONFLICT");
    if (current.editorial_restriction !== "EMERGENCY_UNLIST") throw new EditorialError("EMERGENCY_UNLIST_REQUIRED");
    if (current.editorial_requested_visibility !== "LISTED") throw new EditorialError("EDITORIAL_VISIBILITY_NOT_LISTED");
    if (current.withdrawn_at !== null || !db.prepare("SELECT 1 FROM products WHERE course_ref=? AND kind='ONLINE_COURSE'").get(input.courseRef))
      throw new EditorialError("ACTIVE_COURSE_PRODUCT_REQUIRED");
    const version = current.version + 1;
    db.prepare("UPDATE catalog_course_projection SET version=?,visibility='LISTED',editorial_restriction='NONE',applied_at=? WHERE course_ref=?")
      .run(version, now, input.courseRef);
    const snapshot = publishedSnapshot(db, input.courseRef);
    if (Buffer.byteLength(snapshot, "utf8") > 1_048_576) throw new EditorialError("PUBLISHED_GRAPH_TOO_LARGE");
    const contentHash = sha(snapshot);
    db.prepare("UPDATE catalog_course_projection SET content_hash=?,state_hash=? WHERE course_ref=?")
      .run(contentHash, contentHash, input.courseRef);
    const draft = db.prepare("SELECT revision FROM course_editorial_drafts WHERE course_ref=?")
      .get(input.courseRef) as { revision: number } | undefined;
    const draftRevision = draft?.revision ?? 0;
    db.prepare(`INSERT INTO course_editorial_versions(course_ref,version,draft_revision,document_json,content_hash,actor,published_at)
      VALUES (?,?,?,?,?,?,?)`).run(input.courseRef, version, draftRevision, snapshot, contentHash, input.actor, now);
    const result: PublicationResult = { courseRef: input.courseRef, version, draftRevision, contentHash, visibility: "LISTED", replayed: false };
    db.prepare(`INSERT INTO course_editorial_publish_commands(course_ref,idempotency_key,request_hash,result_json,created_at)
      VALUES (?,?,?,?,?)`).run(input.courseRef, input.idempotencyKey, requestHash, JSON.stringify(result), now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.actor, "COURSE_EDITORIAL_RELISTED", "course", input.courseRef,
        JSON.stringify({ version, contentHash, idempotencyKey: input.idempotencyKey, reason: input.reason.trim() }), now);
    return result;
  });
  return relist.immediate();
}
