import { Suspense } from "react";
import { HomeLessonChapter } from "@/components/home/HomeCourseChapter";

export default function InterceptedLesson({ params }: {
  params: Promise<{ slug: string; lessonSlug: string }>;
}) {
  return <Suspense fallback={null}><HomeLessonChapter params={params} /></Suspense>;
}
