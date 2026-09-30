import { headers } from "next/headers";
import { listEntitledCourses } from "@/lib/content/entitled";
import { getCommercialSummaries } from "@/lib/commerce-summary";

export async function GET() {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const [courses, commercial] = await Promise.all([listEntitledCourses(cookieHeader), getCommercialSummaries()]);
  return Response.json({
    courses: courses
      .filter((course) => !commercial.get(course.courseRef)?.withdrawn)
      .map(({ courseRef, title, slug }) => ({ courseRef, title, url: `/courses/${slug}` })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
