import { publicCourses } from "@/lib/content/public";
import { coursePath } from "@/lib/seo";
import { catalogueAlias, isOrbitArtwork } from "@/components/home/orbit-course";

export async function GET(_request: Request, { params }: { params: Promise<{ courseAlias: string }> }) {
  const { courseAlias } = await params;
  if (!isOrbitArtwork(courseAlias)) return new Response(null, { status: 404 });

  const courses = await publicCourses().catch(() => null);
  if (!courses) return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });

  const alternative = catalogueAlias(courseAlias);
  const published = courses.some(({ course }) => course.slug === courseAlias) ? courseAlias
    : courses.find(({ course }) => course.slug === alternative)?.course.slug;
  if (!published) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  return new Response(null, {
    status: 308,
    headers: { Location: coursePath(published), "Cache-Control": "no-store" },
  });
}
