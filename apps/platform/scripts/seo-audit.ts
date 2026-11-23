/**
 * Runs the FLEX-70 SEO audit against a rendered platform server.
 *
 *   tsx apps/platform/scripts/seo-audit.ts <base-url> [--production] [--origin <canonical-origin>] <path>[:noindex] ...
 *
 * `--origin` is the configured PLATFORM_ORIGIN; canonical and og:url must use it even when the server
 * is reached on a loopback port. A path suffixed
 * with `:noindex` must carry `noindex`; every other path must be indexable. Exits 1 on any issue.
 */
import { auditRenderedPage, auditRobots, renderedOgImages } from "../lib/seo-audit";

async function main(argv: string[]) {
  const [base, ...rest] = argv;
  if (!base) throw new Error("usage: seo-audit <base-url> [--production] [--origin <origin>] <path>[:noindex] ...");
  let production = false;
  let origin: string | undefined;
  const paths: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--production") production = true;
    else if (rest[index] === "--origin") origin = rest[++index];
    else paths.push(rest[index]);
  }
  const issues: string[] = [];

  const robots = await fetch(new URL("/robots.txt", base), { redirect: "manual" });
  issues.push(...auditRobots(await robots.text(), production).map((issue) => `/robots.txt: ${issue}`));

  for (const entry of paths) {
    const [path, flag] = entry.split(":");
    // Next sends blocking metadata in <head> to HTML-limited crawlers.
    const response = await fetch(new URL(path, base), { redirect: "manual", headers: { "user-agent": "Twitterbot" } });
    if (response.status !== 200) { issues.push(`${path}: HTTP ${response.status}`); continue; }
    const url = new URL(path, origin ?? base).toString();
    const html = await response.text();
    issues.push(...auditRenderedPage(html, { url, indexable: flag !== "noindex" }).map((issue) => `${path}: ${issue}`));
    // Read-back: a same-origin og:image must actually be served by this build as WebP.
    for (const source of renderedOgImages(html)) {
      const image = URL.parse(source);
      if (!image) continue; // auditRenderedPage reports malformed URLs.
      if (image.origin !== new URL(origin ?? base).origin) continue;
      const served = await fetch(new URL(image.pathname, base), { redirect: "manual" });
      await served.arrayBuffer();
      if (served.status !== 200 || served.headers.get("content-type") !== "image/webp") {
        issues.push(`${path}: og:image ${image.pathname} is not served as image/webp (HTTP ${served.status})`);
      }
    }
  }
  for (const issue of issues) console.error(issue);
  console.log(issues.length ? `SEO audit failed: ${issues.length} issue(s)` : `SEO audit passed for ${paths.length} page(s)`);
  process.exitCode = issues.length ? 1 : 0;
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
