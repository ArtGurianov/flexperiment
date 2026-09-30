import { randomUUID } from "node:crypto";
import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, PayloadRequest } from "payload";
import { getCourseForDocument, getPublishedDocument, relationId, type EditorialDocument } from "@/lib/content/editorial";
import { createCommerceOverride } from "./commerce-client";
import type { RestrictiveOperation, Restriction } from "./contracts";
import { beginInFlightOperation, finishLocalOperation, getPlatformEpoch } from "./in-flight";

type Entity = "course" | "section" | "lesson";
type PendingContext = Record<string, RestrictiveOperation[]>;
const contextKey = "__lmsRestrictiveOperations";
const skipKey = "__lmsSkipManifestHook";

const asDocument = (value: unknown): EditorialDocument => value as EditorialDocument;
const stringValue = (document: EditorialDocument, key: string) => {
  const value = document[key];
  if (typeof value !== "string" || !value) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value;
};

const entityKey = (entity: Entity, document: EditorialDocument) => `${entity}:${String(document.id)}`;

function contextOperations(req: PayloadRequest): PendingContext {
  const context = req.context as Record<string, unknown>;
  const existing = context[contextKey];
  if (existing && typeof existing === "object") return existing as PendingContext;
  const created: PendingContext = {};
  context[contextKey] = created;
  return created;
}

function restrictiveIntents(entity: Entity, previous: EditorialDocument, next: EditorialDocument): Restriction[] {
  const restrictions: Restriction[] = [];
  if (previous.visibility === "listed" && next.visibility === "unlisted") {
    restrictions.push({ kind: "EFFECTIVE_VISIBILITY", value: "UNLISTED" });
  }
  if (entity === "lesson" && previous.freePreview === true && next.freePreview !== true) {
    restrictions.push({ kind: "FREE_PREVIEW", value: "FALSE" });
  }
  return restrictions;
}

async function validateLessonMembership(req: PayloadRequest, document: EditorialDocument) {
  const section = await getPublishedDocument(req, "sections", relationId(document.section));
  if (!section || String(relationId(section.course)) !== String(relationId(document.course))) {
    throw new Error("LESSON_SECTION_OUTSIDE_COURSE");
  }
}

export const prepareManifestChange = (entity: Entity): CollectionBeforeChangeHook => async ({ data, originalDoc, req }) => {
  if ((req.context as Record<string, unknown>)[skipKey]) return data;
  const next = { ...(originalDoc ?? {}), ...data } as EditorialDocument;
  if (next._status !== "published") return data;
  if (entity === "lesson") await validateLessonMembership(req, next);
  if (!originalDoc?.id) return data;

  const collection = entity === "course" ? "courses" : entity === "section" ? "sections" : "lessons";
  const previous = await getPublishedDocument(req, collection, originalDoc.id);
  if (!previous || previous._status !== "published") return data;
  const course = await getCourseForDocument(req, next);
  const courseRef = stringValue(course, "courseRef");
  const refKey = entity === "course" ? "courseRef" : entity === "section" ? "sectionRef" : "lessonRef";
  const ref = stringValue(next, refKey);
  const operations: RestrictiveOperation[] = [];

  for (const expected of restrictiveIntents(entity, previous, next)) {
    const operationId = randomUUID();
    const inFlight = beginInFlightOperation(operationId, req);
    const operation: RestrictiveOperation = {
      operationId,
      courseRef,
      scope: { level: entity.toUpperCase() as "COURSE" | "SECTION" | "LESSON", ref },
      expected,
      deadlineAt: inFlight.deadlineAt,
      platformEpoch: getPlatformEpoch(),
    };
    try {
      await createCommerceOverride(operation, AbortSignal.timeout(Math.max(1, Date.parse(inFlight.deadlineAt) - Date.now())));
      operations.push(operation);
    } catch (error) {
      finishLocalOperation(operationId);
      throw error;
    }
  }

  if (operations.length > 0) contextOperations(req)[entityKey(entity, asDocument(originalDoc))] = operations;
  return data;
};

const queueManifest = async (req: PayloadRequest, courseId: number | string) => {
  await req.payload.jobs.queue({
    task: "syncCourseManifest" as never,
    input: { courseId: String(courseId) } as never,
    queue: "default",
    req,
  });
};

export const commitManifestChange = (entity: Entity): CollectionAfterChangeHook => async ({ doc, req }) => {
  if ((req.context as Record<string, unknown>)[skipKey] || doc._status !== "published") return doc;
  const document = asDocument(doc);
  const course = await getCourseForDocument(req, document);
  const operations = contextOperations(req)[entityKey(entity, document)] ?? [];
  const nextVersion = Number(course.manifestVersion ?? 0) + 1;
  const context = req.context as Record<string, unknown>;

  context[skipKey] = true;
  try {
    await req.payload.update({
      collection: "courses",
      id: course.id,
      data: { manifestVersion: nextVersion, publicContentUpdatedAt: new Date().toISOString() },
      depth: 0,
      draft: false,
      overrideAccess: true,
      req,
    });
  } finally {
    delete context[skipKey];
  }

  for (const operation of operations) {
    await req.payload.create({
      collection: "access-operations",
      data: {
        operationId: operation.operationId,
        courseRef: operation.courseRef,
        committedVersion: nextVersion,
        state: "COMMITTED_UNACKED",
      },
      depth: 0,
      overrideAccess: true,
      req,
    });
  }
  await queueManifest(req, course.id);
  if (context.__lmsForceThrowAfterQueue === true) throw new Error("FORCED_THROW_AFTER_MANIFEST_ENQUEUE");
  return doc;
};
