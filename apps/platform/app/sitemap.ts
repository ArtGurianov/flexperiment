import type { MetadataRoute } from "next";
import { platformOrigin } from "@/lib/origins";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = platformOrigin();
  // Dynamic course sitemap publication and invalidation are admitted by ART-339.
  return [
    { url: origin, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/courses`, changeFrequency: "daily", priority: 0.9 },
  ];
}
