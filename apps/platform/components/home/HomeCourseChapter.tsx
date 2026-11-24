import { cache, Suspense } from "react";
import { connection } from "next/server";
import LexicalReadOnly from "@/components/courses/LexicalReadOnly";
import { publicCourse } from "@/lib/content/public";
import { coursePath, lessonPath } from "@/lib/seo";
import HomeChapter, { chapterAction } from "./HomeChapter";
import HomeSectionLink from "./HomeSectionLink";

type CourseParams = { slug: string };
type LessonParams = CourseParams & { lessonSlug: string };

const readCourse = cache(async (slug: string) => {
  try {
    return await publicCourse(slug);
  } catch {
    return null;
  }
});

async function CourseChapterContent({ params }: { params: Promise<CourseParams> }) {
  await connection();
  const { slug } = await params;
  const path = coursePath(slug);
  const result = await readCourse(slug);
  if (!result) {
    return <HomeChapter path={path} title="Курс"><p>Курс сейчас недоступен.</p></HomeChapter>;
  }

  const { course, outline } = result;
  return (
    <HomeChapter path={path} title={course.title}>
      <h1 className="m-0 max-w-[16ch] font-display text-[clamp(2rem,8vw,7rem)] font-bold leading-[.95] tracking-[-.06em] [overflow-wrap:anywhere]">
        {course.title}
      </h1>
      <p className="m-0 max-w-[50ch] text-[clamp(1rem,2vw,1.5rem)] leading-relaxed text-paper/85">{course.summary}</p>
      {course.description != null && (
        <div className="max-w-[65ch] leading-relaxed text-paper/90"><LexicalReadOnly data={course.description} /></div>
      )}
      {outline.lessons.length > 0 && (
        <ol aria-label="Уроки курса" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {outline.lessons.map(lesson => (
            <li key={lesson.lessonRef}>
              <HomeSectionLink href={lessonPath(slug, lesson.slug)} className="inline-block border border-paper/30 px-3 py-2 font-bold underline">
                {lesson.title}
              </HomeSectionLink>
            </li>
          ))}
        </ol>
      )}
      <HomeSectionLink href="/all-courses" className="w-fit font-bold underline underline-offset-4">Все курсы комплектом <span aria-hidden>↓</span></HomeSectionLink>
    </HomeChapter>
  );
}

export function HomeCourseChapter({ params }: { params: Promise<CourseParams> }) {
  return <Suspense fallback={null}><CourseChapterContent params={params} /></Suspense>;
}

export async function HomeLessonChapter({ params }: { params: Promise<LessonParams> }) {
  await connection();
  const { slug, lessonSlug } = await params;
  const path = lessonPath(slug, lessonSlug);
  const result = await readCourse(slug);
  const lesson = result?.outline.lessons.find(item => item.slug === lessonSlug);
  return (
    <HomeChapter path={path} title={lesson?.title ?? "Урок"}>
      <h2 className="m-0 font-display text-[clamp(2rem,7vw,5rem)] font-bold leading-none">{lesson?.title ?? "Урок сейчас недоступен"}</h2>
      <HomeSectionLink href={coursePath(slug)} className={chapterAction}>← К курсу</HomeSectionLink>
    </HomeChapter>
  );
}
