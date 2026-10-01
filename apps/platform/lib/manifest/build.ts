import type { Payload, PayloadRequest } from "payload";
import { getCourseManifestState, listPublishedCourseState, listUnacknowledgedOperations, relationId, type EditorialDocument } from "@/lib/content/editorial";
import type { CourseManifest, Visibility } from "./contracts";
import { withManifestHash } from "./hash";

const requiredString = (doc: EditorialDocument, key: string): string => {
  const value = doc[key];
  if (typeof value !== "string" || !value) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value;
};

const visibility = (value: unknown): Visibility => value === "unlisted" ? "UNLISTED" : "LISTED";
const integer = (value: unknown, fallback = 0) => Number.isInteger(value) ? Number(value) : fallback;

export async function buildCourseManifest(
  payload: Payload,
  course: EditorialDocument,
  req?: PayloadRequest,
): Promise<CourseManifest> {
  if (course._status !== "published") throw new Error("COURSE_NOT_PUBLISHED");
  const courseRef = requiredString(course, "courseRef");
  const version = integer((await getCourseManifestState(payload, courseRef, req))?.manifestVersion);
  if (version < 1) throw new Error("MANIFEST_VERSION_NOT_COMMITTED");
  const { sections, lessons } = await listPublishedCourseState(payload, course.id, req);
  const operations = await listUnacknowledgedOperations(payload, courseRef, req);
  const sectionRefById = new Map(sections.map((section) => [String(section.id), requiredString(section, "sectionRef")]));

  return withManifestHash({
    courseRef,
    version,
    visibility: visibility(course.visibility),
    sections: sections.map((section, position) => ({
      sectionRef: requiredString(section, "sectionRef"),
      visibility: visibility(section.visibility),
      position,
    })),
    lessons: lessons.map((lesson) => {
      const sectionRef = sectionRefById.get(String(relationId(lesson.section)));
      if (!sectionRef) throw new Error("LESSON_SECTION_MISSING");
      return {
        lessonRef: requiredString(lesson, "lessonRef"),
        sectionRef,
        everPublished: lesson.everPublished === true,
        visibility: visibility(lesson.visibility),
        freePreview: lesson.freePreview === true,
        position: integer(lesson.position),
      };
    }),
    operations: operations.map((operation) => ({
      operationId: requiredString(operation, "operationId"),
      committedVersion: integer(operation.committedVersion),
    })),
  });
}
