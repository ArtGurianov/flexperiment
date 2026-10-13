export type Visibility = "LISTED" | "UNLISTED";
export type LexicalContent = { root: { type: "root"; version: number; children: unknown[] } };
export type EditorialSection = { sectionRef: string; title: string; position: number; visibility: Visibility };
export type EditorialLesson = {
  lessonRef: string; title: string; slug: string; sectionRef: string; position: number;
  visibility: Visibility; freePreview: boolean; description?: LexicalContent | null;
  seo?: { title?: string; description?: string };
};
export type EditorialDocument = {
  courseRef: string; title: string; slug: string; summary: string; visibility: Visibility;
  description?: LexicalContent | null; seo?: { title?: string; description?: string };
  sections: EditorialSection[]; lessons: EditorialLesson[];
};

export type EditorialDraft = { courseRef: string; revision: number; document: EditorialDocument; updatedAt: string };
export type PublishedSnapshot = {
  course: {
    course_ref: string; version: number; title: string; slug: string; summary: string;
    visibility: Visibility; editorial_requested_visibility: Visibility;
    editorial_restriction: "NONE" | "EMERGENCY_UNLIST" | "WITHDRAWN";
    description_json: string | null; seo_json: string | null;
  };
  sections: Array<{ section_ref: string; title: string; position: number; visibility: Visibility }>;
  lessons: Array<{
    lesson_ref: string; section_ref: string; title: string; slug: string; position: number;
    visibility: Visibility; free_preview: number; description_json: string | null; seo_json: string | null;
  }>;
};

const newRef = (kind: "section" | "lesson") => `${kind}-${crypto.randomUUID()}`;
const slugFromRef = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "course";
const parsed = <T,>(json: string | null): T | null => json ? JSON.parse(json) as T : null;

export function blankEditorialDocument(courseRef: string): EditorialDocument {
  const sectionRef = newRef("section");
  return {
    courseRef, title: "", slug: slugFromRef(courseRef), summary: "", visibility: "UNLISTED", description: null,
    sections: [{ sectionRef, title: "", position: 0, visibility: "LISTED" }],
    lessons: [{ lessonRef: newRef("lesson"), sectionRef, title: "", slug: "first-lesson", position: 0,
      visibility: "LISTED", freePreview: false, description: null }],
  };
}

export function documentFromPublished(snapshot: PublishedSnapshot): EditorialDocument {
  return {
    courseRef: snapshot.course.course_ref,
    title: snapshot.course.title,
    slug: snapshot.course.slug,
    summary: snapshot.course.summary,
    visibility: snapshot.course.editorial_requested_visibility,
    description: parsed<LexicalContent>(snapshot.course.description_json),
    seo: parsed<EditorialDocument["seo"]>(snapshot.course.seo_json) ?? undefined,
    sections: snapshot.sections.map((section) => ({ sectionRef: section.section_ref, title: section.title,
      position: section.position, visibility: section.visibility })),
    lessons: snapshot.lessons.map((lesson) => ({ lessonRef: lesson.lesson_ref, sectionRef: lesson.section_ref,
      title: lesson.title, slug: lesson.slug, position: lesson.position, visibility: lesson.visibility,
      freePreview: Boolean(lesson.free_preview), description: parsed<LexicalContent>(lesson.description_json),
      seo: parsed<EditorialLesson["seo"]>(lesson.seo_json) ?? undefined })),
  };
}

export function normalizedEditorialDocument(document: EditorialDocument): EditorialDocument {
  const sections = document.sections.map((section, position) => ({ ...section, position }));
  const lessons = sections.flatMap((section) => document.lessons.filter((lesson) => lesson.sectionRef === section.sectionRef)
    .map((lesson, position) => ({ ...lesson, position })));
  return { ...document, sections, lessons };
}

export function newSection(): EditorialSection {
  return { sectionRef: newRef("section"), title: "", position: 0, visibility: "LISTED" };
}

export function newLesson(sectionRef: string): EditorialLesson {
  const lessonRef = newRef("lesson");
  return { lessonRef, sectionRef, title: "", slug: `lesson-${lessonRef.slice(-8)}`, position: 0,
    visibility: "LISTED", freePreview: false, description: null };
}
