import { publicCourses } from "@/lib/content/public";
import { coursePath } from "@/lib/seo";
import { LEGACY_COURSE_ALIASES } from "@/lib/legacy-course-aliases";

export async function GET(_request: Request, { params }: { params: Promise<{ courseAlias: string }> }) {
  const { courseAlias } = await params;
  const courseRef = LEGACY_COURSE_ALIASES.get(courseAlias);
  if (!courseRef) return new Response(null, { status: 404 });

  const courses = await publicCourses().catch(() => null);
  if (!courses) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });

  const published = courses.find(({ course }) => course.courseRef === courseRef)?.course.slug;
  if (!published) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  // Commerce rejects changes to a published slug (COURSE_SLUG_IMMUTABLE).
  return new Response(null, {
    status: 308,
    headers: { Location: coursePath(published), "Cache-Control": "no-store" },
  });
}
