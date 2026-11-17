import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import LexicalReadOnly from "@/components/courses/LexicalReadOnly";
import { publicCourse } from "@/lib/content/public";
import HomeChapter, { chapterAction } from "./HomeChapter";
import HomeSectionLink from "./HomeSectionLink";
import { catalogueAlias, isOrbitArtwork, ORBIT_COURSE_ORDER } from "./orbit-course";

type Props = { params: Promise<{ artwork: string }> };

export function generateStaticParams() {
  return ORBIT_COURSE_ORDER.map((artwork) => ({ artwork }));
}

async function CourseChapterContent({ artwork }: { artwork: string }) {
  await connection();
  if (!isOrbitArtwork(artwork)) notFound();

  let course;
  try {
    const alias = catalogueAlias(artwork);
    course = await publicCourse(artwork) ?? (alias ? await publicCourse(alias) : null);
  } catch {
    return <HomeChapter path={`/${artwork}`} title="Курс"><p>Курс временно недоступен.</p></HomeChapter>;
  }
  if (!course) notFound();

  return (
    <HomeChapter path={`/${artwork}`} title={course.course.title}>
      <h1 className="m-0 max-w-[16ch] font-display text-[clamp(2rem,8vw,7rem)] font-bold leading-[.95] tracking-[-.06em] [overflow-wrap:anywhere]">
        {course.course.title}
      </h1>
      <p className="m-0 max-w-[50ch] text-[clamp(1rem,2vw,1.5rem)] leading-relaxed text-paper/85">{course.course.summary}</p>
      {course.course.description != null && (
        <div className="max-w-[65ch] leading-relaxed text-paper/90"><LexicalReadOnly data={course.course.description} /></div>
      )}
      {course.outline.sections.length > 0 && (
        <ul aria-label="Разделы курса" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {course.outline.sections.slice(0, 4).map((section) => (
            <li key={section.sectionRef} className="border border-paper/30 px-3 py-2 text-sm">{section.title}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
        <Link href={`/courses/${encodeURIComponent(course.course.slug)}`} className={chapterAction}>Программа курса <span aria-hidden>↗</span></Link>
        <HomeSectionLink href="/all-courses" className="w-fit font-bold underline underline-offset-4">Все курсы комплектом <span aria-hidden>↓</span></HomeSectionLink>
      </div>
    </HomeChapter>
  );
}

export function HomeCourseChapter({ artwork }: { artwork: string }) {
  return <Suspense fallback={null}><CourseChapterContent artwork={artwork} /></Suspense>;
}

async function CourseChapterRoute({ params }: Props) {
  const { artwork } = await params;
  if (!isOrbitArtwork(artwork)) notFound();
  return <HomeCourseChapter artwork={artwork} />;
}

export default function HomeCoursePage(props: Props) {
  return <Suspense fallback={null}><CourseChapterRoute {...props} /></Suspense>;
}
