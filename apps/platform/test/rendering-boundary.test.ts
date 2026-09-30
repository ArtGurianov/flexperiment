import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platform = resolve(import.meta.dirname, "..");
const source = (path: string) => readFile(resolve(platform, path), "utf8");

describe("static-first storefront rendering", () => {
  it("uses Cache Components and partial prefetching", async () => {
    const config = await source("next.config.ts");
    expect(config).toContain("cacheComponents: true");
    expect(config).toContain("partialPrefetching: true");
  });

  it("keeps public catalogue shells prerenderable and request state behind Suspense", async () => {
    const [catalog, course, lesson] = await Promise.all([
      source("app/(frontend)/courses/page.tsx"),
      source("app/(frontend)/courses/[slug]/page.tsx"),
      source("app/(frontend)/courses/[slug]/lessons/[lessonSlug]/page.tsx"),
    ]);
    for (const route of [catalog, course, lesson]) {
      expect(route).not.toContain('dynamic = "force-dynamic"');
      expect(route).toContain("<Suspense");
    }
    expect(catalog).toContain("await connection()");
    expect(course).toContain("await headers()");
    expect(lesson).toContain("await headers()");
  });

  it("keeps runtime environment and baked identity routes out of the build-time cache", async () => {
    for (const path of ["app/identity/route.ts", "app/robots.txt/route.ts", "app/indexnow-key.txt/route.ts"]) {
      expect(await source(path)).toContain("await connection()");
    }
  });
});
