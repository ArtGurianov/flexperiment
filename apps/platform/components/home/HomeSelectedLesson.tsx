"use client";

import { useContext } from "react";
import { HomeLessonSelection } from "./HomeSectionLink";
import { usePathname } from "next/navigation";
import LessonPlayer from "@/components/kinescope/LessonPlayer";
import type { StorefrontLesson } from "@/lib/content/public";
import type { CourseCommercialSummary } from "@/lib/commerce-summary";

export default function HomeSelectedLesson({ path, lesson, courseSlug, commercial }: {
  path: string;
  lesson: Pick<StorefrontLesson, "lessonRef" | "slug" | "title">;
  courseSlug: string;
  commercial: CourseCommercialSummary;
}) {
  const pathname = usePathname();
  const selected = useContext(HomeLessonSelection);
  if (pathname !== path) return null;
  return <LessonPlayer lessonRef={lesson.lessonRef} title={lesson.title}
    enrollment={{ courseSlug, lessonSlug: lesson.slug, accessModel: commercial.accessModel }}
    commercial={commercial} offerDialog={selected === path} />;
}
