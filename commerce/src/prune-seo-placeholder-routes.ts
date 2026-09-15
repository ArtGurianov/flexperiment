import { readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  PLACEHOLDER_PARAM,
  PLACEHOLDER_ROUTE_SEGMENTS,
} from "../../lib/seo/snapshot-source";

/**
 * Removes the reserved placeholder route from the static export.
 *
 * Next 16 refuses an empty `generateStaticParams()` under `output: "export"`,
 * so app/events/[slug] and app/cities/[city] emit one placeholder each when the
 * SEO snapshot has nothing to publish. That placeholder renders the branded 404
 * body, but it is still a file, and a file is a URL that answers 200 — a
 * fabricated event URL on a public site. This deletes it, so "zero eligible
 * occurrences produces zero event and city pages" is true of the artifact that
 * actually ships and not merely of the data.
 *
 * Runs as part of `pnpm build`, alongside release:static-descriptor, so the
 * Docker image and CI get the same treatment with no Dockerfile change.
 *
 * Deliberately narrow: it removes exactly the files and directory whose name is
 * the reserved param, under exactly the two known segments, and it is a no-op
 * when inventory exists. It never inspects or removes anything else, so it
 * cannot quietly delete a real page.
 */
const OUT = resolve(process.cwd(), "out");

const removed: string[] = [];

for (const segment of PLACEHOLDER_ROUTE_SEGMENTS) {
  const directory = resolve(OUT, segment);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    // No such route in this build — nothing was generated for it at all.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }

  for (const entry of entries) {
    // `__placeholder__`, `__placeholder__.html`, `__placeholder__.txt` and the
    // RSC payload directory of the same name. Matching on the stem keeps this
    // correct if Next adds another sibling artifact.
    const stem = entry.replace(/\.[^.]+$/, "");
    if (stem !== PLACEHOLDER_PARAM) continue;
    rmSync(resolve(directory, entry), { recursive: true, force: true });
    removed.push(`${segment}/${entry}`);
  }

  // A route directory left holding nothing is itself noise in the artifact.
  if (readdirSync(directory).length === 0) {
    rmSync(directory, { recursive: true, force: true });
    removed.push(`${segment}/`);
  } else if (!statSync(directory).isDirectory()) {
    throw new Error("SEO_PLACEHOLDER_PRUNE_UNEXPECTED_ENTRY");
  }
}

process.stdout.write(
  removed.length > 0
    ? `pruned SEO placeholder routes: ${removed.join(", ")}\n`
    : "no SEO placeholder routes to prune\n",
);
