"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AccountLibraryCourse } from "@/lib/content/entitled";
import type { CourseDetail } from "@/lib/content/public";
import { coursePath, lessonPath } from "@/lib/seo";
import FreeEnrollmentAction from "../courses/FreeEnrollmentAction";
import HomeSectionLink from "./HomeSectionLink";

type Access = { course: AccountLibraryCourse | null } | "unavailable";

export default function HomeCourseProgram({ course, commercial, outline, actionClassName, myLogin }: Omit<CourseDetail, "course"> & { course: Pick<CourseDetail["course"], "slug" | "courseRef">; actionClassName: string; myLogin?: string }) {
  const pathname = usePathname();
  const path = coursePath(course.slug);
  const active = pathname === path;
  const [access, setAccess] = useState<Access | null>(null);

  useEffect(() => {
    if (!active) return;
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      setAccess(null);
      void fetch("/account-courses.json", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error("COURSE_ACCESS_UNAVAILABLE");
          const { courses } = await response.json() as { courses: AccountLibraryCourse[] };
          if (!controller.signal.aborted) {
            setAccess({ course: courses.find(item => item.courseRef === course.courseRef) ?? null });
          }
        })
        .catch(() => { if (!controller.signal.aborted) setAccess("unavailable"); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      request?.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [active, course.courseRef]);

  const owned = access && access !== "unavailable" ? access.course : null;
  const allowed = new Set(owned?.lessons.map(lesson => lesson.lessonRef));
  const firstAccessible = outline.lessons.find(lesson => allowed.has(lesson.lessonRef));
  const fullCourse = owned && owned.access !== "PREVIEW";
  const target = fullCourse ? owned.continuation?.lesson : undefined;
  const first = firstAccessible ?? outline.lessons[0];
  const next = target?.url ?? (first ? lessonPath(course.slug, first.slug) : null);
  const canonicalOnly = target && !outline.lessons.some(lesson => lesson.lessonRef === target.lessonRef);
  const action = fullCourse ? owned.started ? "Продолжить" : "Начать курс" : "Смотреть";

  return <>
    <div className="min-h-16">
      {active && <>
        {access === null && <p role="status">Проверяем доступ…</p>}
        {access === "unavailable" && <p role="status">Не удалось проверить доступ. Урок можно открыть из программы.</p>}
        {commercial.accessModel === "FREE" && !firstAccessible && !target
          && <FreeEnrollmentAction courseSlug={course.slug} accessModel="FREE" myLogin={myLogin} compact />}
        {next && (target || firstAccessible || commercial.accessModel === "PAID") && <>
          {canonicalOnly ? <a className={actionClassName} href={next}>{action}</a>
            : <HomeSectionLink className={actionClassName} href={next}>{action}</HomeSectionLink>}
          {owned?.continuation?.reason === "PREVIOUS_UNAVAILABLE" && <p>Предыдущий урок недоступен. Откроется первый доступный.</p>}
          {owned?.continuation?.reason === "REWATCH" && <p>Можно пересмотреть последний урок.</p>}
          {!target && !firstAccessible && <p>Условия доступа указаны на странице урока.</p>}
        </>}
      </>}
    </div>
    {outline.sections.length > 0 && <section aria-label="Программа курса" className="grid gap-2">
      {outline.sections.map(section => <details key={section.sectionRef} className="border border-paper/30 px-3 py-2">
        <summary className="cursor-pointer font-bold">{section.title}</summary>
        <ol className="my-2 grid gap-2 pl-5">
          {outline.lessons.filter(lesson => lesson.sectionRef === section.sectionRef).map(lesson => (
            <li key={lesson.lessonRef}>
              <HomeSectionLink href={lessonPath(course.slug, lesson.slug)} className="font-bold underline">
                {lesson.title}
              </HomeSectionLink>
              {commercial.accessModel === "FREE" && <small> · Бесплатный курс</small>}
              {commercial.accessModel === "PAID" && lesson.freePreview && <small> · Бесплатный просмотр</small>}
              {active && access && access !== "unavailable" && !allowed.has(lesson.lessonRef) && <small> · Требуется доступ</small>}
            </li>
          ))}
        </ol>
      </details>)}
    </section>}
    <Link href="/courses" className="w-fit underline underline-offset-4">Все курсы</Link>
  </>;
}
