import { cache, Suspense } from "react";
import { connection } from "next/server";
import { lessonEntry } from "@/lib/lesson-entry";
import LexicalReadOnly from "@/components/courses/LexicalReadOnly";
import { publicCourse } from "@/lib/content/public";
import { coursePath, lessonPath } from "@/lib/seo";
import HomeChapter, { chapterAction } from "./HomeChapter";
import HomeSectionLink from "./HomeSectionLink";
import HomeCourseProgram from "./HomeCourseProgram";
import HomeSelectedLesson from "./HomeSelectedLesson";

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

  const { course } = result;
  return (
    <HomeChapter path={path} title={course.title}>
      <h1 className="m-0 max-w-[16ch] font-display text-[clamp(2rem,8vw,7rem)] font-bold leading-[.95] tracking-[-.06em] [overflow-wrap:anywhere]">
        {course.title}
      </h1>
      <p className="m-0 max-w-[50ch] text-[clamp(1rem,2vw,1.5rem)] leading-relaxed text-paper/85">{course.summary}</p>
      {course.description != null && (
        <div className="max-w-[65ch] leading-relaxed text-paper/90"><LexicalReadOnly data={course.description} /></div>
      )}
      <HomeCourseProgram key={course.courseRef} course={{ slug: course.slug, courseRef: course.courseRef }} commercial={result.commercial}
        outline={result.outline} actionClassName={chapterAction} myLogin={lessonEntry(path).myLogin} />
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
      {result && lesson && <HomeSelectedLesson key={lesson.lessonRef} path={path} lesson={lesson}
        courseSlug={result.course.slug} commercial={result.commercial} {...lessonEntry(path)} />}
      <HomeSectionLink href={coursePath(slug)} className={chapterAction}>← К курсу</HomeSectionLink>
    </HomeChapter>
  );
}
