import type { ReactNode } from "react";
import { HomeCourseChapter } from "@/components/home/HomeCourseChapter";

export default function CourseSlotLayout({ children, params }: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  return <><HomeCourseChapter params={params} />{children}</>;
}
