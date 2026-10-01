import { randomUUID } from "node:crypto";
import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, PayloadRequest } from "payload";
import { getCourseForDocument, getCourseManifestState, getPublishedDocument, relationId, type EditorialDocument } from "@/lib/content/editorial";
import { createCommerceOverride } from "./commerce-client";
import type { RestrictiveOperation, Restriction } from "./contracts";
import { beginInFlightOperation, getPlatformEpoch } from "./in-flight";

type Entity = "course" | "section" | "lesson";
type PublishedSnapshot = { readonly visibility: unknown; readonly freePreview: unknown };
const previousKey = "__lmsPublishedBeforeSave";

const collectionFor = (entity: Entity) => entity === "course" ? "courses" : entity === "section" ? "sections" : "lessons";
const asDocument = (value: unknown): EditorialDocument => value as EditorialDocument;
const stringValue = (document: EditorialDocument, key: string) => {
  const value = document[key];
  if (typeof value !== "string" || !value) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value;
};

const entityKey = (entity: Entity, document: EditorialDocument) => `${entity}:${String(document.id)}`;

function publishedSnapshots(req: PayloadRequest): Record<string, PublishedSnapshot> {
  const context = req.context as Record<string, unknown>;
  const existing = context[previousKey];
  if (existing && typeof existing === "object") return existing as Record<string, PublishedSnapshot>;
  const created: Record<string, PublishedSnapshot> = {};
  context[previousKey] = created;
  return created;
}

function restrictiveIntents(entity: Entity, previous: PublishedSnapshot, next: EditorialDocument): Restriction[] {
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

/**
 * Runs before field validation, so it only checks our own invariants and records what is live now.
 * Nothing leaves Payload here: the restrictive diff and the commerce call wait for afterChange, which
 * Payload reaches only once field validation has passed and the document is written.
 */
export const prepareManifestChange = (entity: Entity): CollectionBeforeChangeHook => async ({ data, originalDoc, req }) => {
  const next = { ...(originalDoc ?? {}), ...data } as EditorialDocument;
  if (next._status !== "published") return data;
  if (entity === "lesson") await validateLessonMembership(req, next);
  if (!originalDoc?.id) return data;

  const previous = await getPublishedDocument(req, collectionFor(entity), originalDoc.id);
  const snapshots = publishedSnapshots(req);
  const key = entityKey(entity, asDocument(originalDoc));
  if (previous?._status === "published") snapshots[key] = { visibility: previous.visibility, freePreview: previous.freePreview };
  else delete snapshots[key];
  return data;
};

async function createRestrictiveOverrides(
  req: PayloadRequest,
  entity: Entity,
  courseRef: string,
  document: EditorialDocument,
  intents: readonly Restriction[],
) {
  const refKey = entity === "course" ? "courseRef" : entity === "section" ? "sectionRef" : "lessonRef";
  const operations: RestrictiveOperation[] = [];
  for (const expected of intents) {
    const operationId = randomUUID();
    const inFlight = await beginInFlightOperation(operationId, req);
    const operation: RestrictiveOperation = {
      operationId,
      courseRef,
      scope: { level: entity.toUpperCase() as "COURSE" | "SECTION" | "LESSON", ref: stringValue(document, refKey) },
      expected,
      deadlineAt: inFlight.deadlineAt,
      platformEpoch: getPlatformEpoch(),
    };
    // A failure throws out of the save; the transaction rolls back and the registry entry clears with it.
    await createCommerceOverride(operation, AbortSignal.timeout(Math.max(1, Date.parse(inFlight.deadlineAt) - Date.now())));
    operations.push(operation);
  }
  return operations;
}

/** Bumps the committed manifest version on the unversioned state row, inside the save's transaction. */
async function commitManifestVersion(req: PayloadRequest, courseRef: string) {
  const state = await getCourseManifestState(req.payload, courseRef, req);
  const manifestVersion = Number(state?.manifestVersion ?? 0) + 1;
  const publicContentUpdatedAt = new Date().toISOString();
  if (state) {
    await req.payload.update({
      collection: "course-manifest-states",
      id: state.id,
      data: { manifestVersion, publicContentUpdatedAt },
      depth: 0,
      overrideAccess: true,
      req,
    });
  } else {
    await req.payload.create({
      collection: "course-manifest-states",
      data: { courseRef, manifestVersion, publicContentUpdatedAt, invalidatedVersion: 0 },
      depth: 0,
      overrideAccess: true,
      req,
    });
  }
  return manifestVersion;
}

const queueManifest = async (req: PayloadRequest, courseId: number | string) => {
  await req.payload.jobs.queue({
    task: "syncCourseManifest" as never,
    input: { courseId: String(courseId) } as never,
    queue: "default",
    req,
  });
};

export const commitManifestChange = (entity: Entity): CollectionAfterChangeHook => async ({ doc, req }) => {
  if (doc._status !== "published") return doc;
  const document = asDocument(doc);
  const snapshots = publishedSnapshots(req);
  const key = entityKey(entity, document);
  const previous = snapshots[key];
  delete snapshots[key];

  const course = await getCourseForDocument(req, document);
  const courseRef = stringValue(course, "courseRef");
  const operations = previous
    ? await createRestrictiveOverrides(req, entity, courseRef, document, restrictiveIntents(entity, previous, document))
    : [];
  const committedVersion = await commitManifestVersion(req, courseRef);

  for (const operation of operations) {
    await req.payload.create({
      collection: "access-operations",
      data: {
        operationId: operation.operationId,
        courseRef: operation.courseRef,
        committedVersion,
        state: "COMMITTED_UNACKED",
      },
      depth: 0,
      overrideAccess: true,
      req,
    });
  }
  await queueManifest(req, course.id);
  if ((req.context as Record<string, unknown>).__lmsForceThrowAfterQueue === true) throw new Error("FORCED_THROW_AFTER_MANIFEST_ENQUEUE");
  return doc;
};
