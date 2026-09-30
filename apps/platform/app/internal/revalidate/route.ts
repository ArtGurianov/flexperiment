import { revalidatePath, revalidateTag } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { notifyIndexNow } from "@/lib/cache-invalidation";

const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function POST(request: Request) {
  const expected = process.env.PLATFORM_REVALIDATE_TOKEN ?? process.env.PLATFORM_COMMERCE_SERVICE_TOKEN;
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !presented || !equal(expected, presented)) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  const body = await request.json() as { mode?: "swr" | "immediate"; slug?: string };
  const profile = body.mode === "immediate" ? { expire: 0 } : "max";
  for (const tag of ["catalog", "course", "search", "commerce"]) revalidateTag(tag, profile);
  revalidatePath("/courses");
  revalidatePath("/search-index.json");
  revalidatePath("/sitemap.xml");
  if (body.slug) revalidatePath(`/courses/${body.slug}`);
  await notifyIndexNow(["/courses", "/search-index.json", "/sitemap.xml", ...(body.slug ? [`/courses/${body.slug}`] : [])]);
  return Response.json({ revalidated: true, mode: body.mode ?? "swr" });
}
