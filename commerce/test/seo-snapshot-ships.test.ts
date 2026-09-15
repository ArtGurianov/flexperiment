import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SNAPSHOT_PATH } from "../src/seo-snapshot-io";

/**
 * The seam, not the unit.
 *
 * Every other test in this suite proves the snapshot is correct. None of them
 * proves it reaches the running site — and it only does so because
 * Dockerfile.frontend's `COPY . .` sweeps it in and `.dockerignore` does not
 * exclude `data/`. Both of those are facts about files that have nothing to do
 * with SEO, so nothing would otherwise fail if someone tightened .dockerignore
 * or narrowed the COPY. The build would keep passing and the image would ship
 * with no event pages at all, silently.
 *
 * Written in the style of static-release-descriptor.test.ts's own
 * "copies both static exports into their final nginx images" case.
 */
describe("the SEO snapshot reaches the shipped image", () => {
  const dockerfile = readFileSync("Dockerfile.frontend", "utf8");
  const dockerignore = readFileSync(".dockerignore", "utf8");

  it("is carried into the build context by COPY . .", () => {
    expect(dockerfile).toContain("COPY . .");
    expect(dockerfile.indexOf("COPY . .")).toBeLessThan(dockerfile.indexOf("RUN pnpm build"));
  });

  it("is not excluded from the build context", () => {
    const excluded = dockerignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const pattern of excluded) {
      expect(SNAPSHOT_PATH.startsWith(pattern.replace(/\/$/, "")), `${pattern} excludes the snapshot`).toBe(false);
      expect(pattern).not.toBe("data");
      expect(pattern).not.toBe("data/");
    }
  });

  it("is read from disk at build time rather than bundled, so the path matters", () => {
    // lib/seo/snapshot-source.ts reads process.cwd()/data/seo/... with node:fs,
    // the same way app/legal/[slug]/page.tsx reads its Markdown. That keeps
    // data/seo out of the client bundle graph — and makes the file's presence
    // in the image load-bearing rather than incidental.
    const source = readFileSync("lib/seo/snapshot-source.ts", "utf8");
    expect(source).toContain("readFileSync");
    expect(source).toContain("process.cwd()");
  });

  it("has its placeholder prune wired into the build that the image runs", () => {
    // Without this step the image would ship out/events/__placeholder__.html:
    // a 200 URL carrying a 404 body, describing an event that does not exist.
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    expect(scripts.build).toContain("next build");
    expect(scripts.build).toContain("seo:prune-placeholders");
    expect(scripts.build.indexOf("next build")).toBeLessThan(scripts.build.indexOf("seo:prune-placeholders"));
  });
});
