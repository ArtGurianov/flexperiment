import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { publicCourses } from "@/lib/content/public";
import { platformOrigin } from "@/lib/origins";
import { publicSitemap } from "@/lib/seo";

// Rendered per request from the committed Commerce projection; there is no sitemap cache to invalidate.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  return publicSitemap(platformOrigin(), await publicCourses());
}
