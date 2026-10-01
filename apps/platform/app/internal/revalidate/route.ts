import { revalidatePath, revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { courseIndexNowPaths, notifyIndexNow } from "@/lib/cache-invalidation";
import { publishedCourseSlug } from "@/lib/content/published-course";

const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

type RevalidationRequest = {
  mode?: "swr" | "immediate";
  slug?: string;
  courseRef?: string;
  reason?: "WITHDRAWN";
};

async function courseSlug(body: RevalidationRequest) {
  if (body.slug) return body.slug;
  if (!body.courseRef) return null;
  try {
    return await publishedCourseSlug(body.courseRef);
  } catch {
    // The tags below still expire every cached course page; only the path-level refresh is lost.
    return null;
  }
}

export async function POST(request: Request) {
  const expected = process.env.PLATFORM_REVALIDATE_TOKEN ?? process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !presented || !equal(expected, presented)) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json() as RevalidationRequest;
  const profile = body.mode === "immediate" ? { expire: 0 } : "max";
  for (const tag of ["catalog", "course", "search", "commerce"]) revalidateTag(tag, profile);
  revalidatePath("/courses");
  revalidatePath("/search-index.json");
  revalidatePath("/sitemap.xml");
  const slug = await courseSlug(body);
  if (slug) revalidatePath(`/courses/${slug}`);
  // Content changes are announced by the manifest sync, once per committed version. A withdrawal
  // is the one commerce change that removes public pages, so it is announced here, once per
  // withdrawal command; price and sale-mode changes only expire caches.
  if (body.reason === "WITHDRAWN" && slug) await notifyIndexNow(courseIndexNowPaths(slug));
  return Response.json({ revalidated: true, mode: body.mode ?? "swr" });
}
