import { publicCourses } from "@/lib/content/public";
import { coursePath } from "@/lib/seo";
import { COURSE_IMAGE_MANIFEST } from "@/lib/public-media";

export async function GET(_request: Request, { params }: { params: Promise<{ courseAlias: string }> }) {
  const { courseAlias } = await params;
  if (!COURSE_IMAGE_MANIFEST.some(({ courseRef }) => courseRef === courseAlias)) return new Response(null, { status: 404 });

  const courses = await publicCourses().catch(() => null);
  if (!courses) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });

  const published = courses.find(({ course }) => course.courseRef === courseAlias)?.course.slug;
  if (!published) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  return new Response(null, {
    status: 308,
    headers: { Location: coursePath(published), "Cache-Control": "no-store" },
  });
}
