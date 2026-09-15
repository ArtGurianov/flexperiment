import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Helpers for asserting against the BUILT EXPORT rather than against source.
 *
 * This is a new pattern in this repository — nothing asserted against `out/`
 * before — and it exists because under `output: "export"` the HTML in `out/` is
 * the authoritative SEO artifact. Reading app/page.tsx proves what a developer
 * wrote; reading out/index.html proves what a crawler receives, and the gap
 * between those two is where every defect in this work actually lived. Next's
 * shallow metadata merge silently dropped `twitter:card` from the home page and
 * `og:image` from the legal pages, and neither was visible in the source.
 *
 * These tests require `pnpm build` to have run — CI runs it immediately before
 * `pnpm test:export`, and the guard below fails with that instruction rather
 * than with a confusing ENOENT.
 */
const OUT = path.join(process.cwd(), "out");

export const outPath = (relative: string): string => path.join(OUT, relative);

export const exportExists = (relative: string): boolean => existsSync(outPath(relative));

/** Entries of a directory in the export, or [] when it does not exist. */
export const listExport = (relative: string): readonly string[] =>
  existsSync(outPath(relative)) ? readdirSync(outPath(relative)) : [];

export function readExport(relative: string): string {
  const file = outPath(relative);
  if (!existsSync(file)) {
    throw new Error(
      `out/${relative} is missing. These tests assert against the built export: run \`SOURCE_COMMIT=$(git rev-parse HEAD) pnpm build\` first.`,
    );
  }
  return readFileSync(file, "utf8");
}

/**
 * Just the document head.
 *
 * Every page also embeds its whole RSC payload in an inline <script>, and that
 * payload contains the same meta tags again as JSON. A naive grep over the file
 * therefore double-counts everything — which is exactly how a "there is one
 * title" assertion can pass on a document with two.
 */
export const headOf = (html: string): string => {
  const start = html.indexOf("<head");
  const end = html.indexOf("</head>");
  if (start < 0 || end < 0) throw new Error("no <head> in document");
  return html.slice(start, end);
};

/** The rendered body with scripts stripped, as visible text. */
export const textOf = (html: string): string => {
  const start = html.indexOf("<body");
  const end = html.indexOf("</body>");
  const body = html.slice(start, end < 0 ? undefined : end);
  return body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/** The `content` of a `<meta name="…">` in the head, or null. */
export const metaName = (html: string, name: string): string | null => {
  const match = new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(headOf(html));
  return match ? match[1] : null;
};

/** The `content` of a `<meta property="…">` in the head, or null. */
export const metaProperty = (html: string, property: string): string | null => {
  const match = new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(headOf(html));
  return match ? match[1] : null;
};

export const canonicalOf = (html: string): string | null => {
  const match = /<link rel="canonical" href="([^"]*)"/.exec(headOf(html));
  return match ? match[1] : null;
};

export const titleOf = (html: string): string | null => {
  const match = /<title>([^<]*)<\/title>/.exec(headOf(html));
  return match ? match[1] : null;
};

export const countIn = (haystack: string, needle: RegExp): number =>
  haystack.match(needle)?.length ?? 0;

/** Every application/ld+json block in the document, already parsed. */
export const structuredData = (html: string): unknown[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]) as unknown);

/** The routes that must never be indexed, with the file each one exports to. */
export const UTILITY_ROUTES = [
  "ticket.html",
  "payment/success.html",
  "refund.html",
  "refund/confirm.html",
] as const;

export const LEGAL_SLUGS = [
  "privacy-policy",
  "personal-data-consent",
  "public-offer",
  "disclaimer",
] as const;
