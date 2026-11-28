import type Database from "better-sqlite3";

type SectionRow = { section_ref: string; title: string; position: number };
type LessonRow = { lesson_ref: string; section_ref: string; title: string; slug: string; position: number;
  free_preview: number; description_json: string | null; seo_json: string | null };

export function storefrontOutline(db: Database.Database, courseRef: string, allowedLessonRefs?: ReadonlySet<string>) {
  const publicOnly = !allowedLessonRefs;
  const sections = db.prepare(`SELECT section_ref,title,position FROM catalog_section_projection
    WHERE course_ref=? ${publicOnly ? "AND visibility='LISTED'" : ""}
      AND title IS NOT NULL ORDER BY position,section_ref`)
    .all(courseRef) as SectionRow[];
  const sectionOrder = new Map(sections.map((section, index) => [section.section_ref, index]));
  const lessons = (db.prepare(`SELECT lesson_ref,section_ref,title,slug,position,free_preview,description_json,seo_json
    FROM catalog_lesson_projection WHERE course_ref=? ${publicOnly ? "AND visibility='LISTED'" : ""}
      AND ever_published=1
      AND withdrawn_at IS NULL AND title IS NOT NULL AND slug IS NOT NULL
    ORDER BY position,lesson_ref`).all(courseRef) as LessonRow[])
    .filter(lesson => sectionOrder.has(lesson.section_ref)
      && (!allowedLessonRefs || allowedLessonRefs.has(lesson.lesson_ref)))
    .sort((left, right) => (sectionOrder.get(left.section_ref)! - sectionOrder.get(right.section_ref)!)
      || left.position - right.position || left.lesson_ref.localeCompare(right.lesson_ref));
  const visibleSectionRefs = allowedLessonRefs && new Set(lessons.map(lesson => lesson.section_ref));
  return {
    sections: sections.filter(section => !visibleSectionRefs || visibleSectionRefs.has(section.section_ref))
      .map(section => ({ sectionRef: section.section_ref, title: section.title, position: section.position })),
    lessons: lessons.map(lesson => ({ lessonRef: lesson.lesson_ref, sectionRef: lesson.section_ref,
      title: lesson.title, slug: lesson.slug, position: lesson.position, freePreview: Boolean(lesson.free_preview) })),
    lessonRows: lessons,
  };
}
