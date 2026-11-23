/**
 * FLEX-70 rendered-server SEO audit (the V2 port of the Mikluha seo-audit checks). It inspects the
 * HTML the running server actually sends, not the metadata objects, so a layout or framework change
 * that drops a tag is caught. Parsing is deliberately minimal: only <head>-level tags Next emits.
 */

export type SeoAuditExpectation = {
  /** The absolute URL that was requested. */
  readonly url: string;
  /** Whether the page must be indexable (`true`) or must carry `noindex` (`false`). */
  readonly indexable: boolean;
};

type Tag = Record<string, string>;

const attributes = (source: string): Tag => {
  const result: Tag = {};
  for (const match of source.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    result[match[1].toLowerCase()] = decode(match[3] ?? match[4] ?? "");
  }
  return result;
};
const decode = (value: string) => value.replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map((m) => attributes(m[1]));
const meta = (html: string, key: string) => tags(html, "meta")
  .filter((tag) => tag.name === key || tag.property === key).map((tag) => tag.content ?? "");

function metadataHead(html: string): string {
  const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const beforeBody = markup.split(/<body\b/i, 1)[0];
  return beforeBody.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? "";
}

export const renderedOgImages = (html: string) => meta(metadataHead(html), "og:image");

const absoluteHttps = (value: string, origin?: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!origin || url.origin === origin);
  } catch { return false; }
};

export function auditRenderedPage(html: string, expected: SeoAuditExpectation): string[] {
  const issues: string[] = [];
  const page = new URL(expected.url);
  const canonicalOrigin = (value: string) => { try { return new URL(value).origin; } catch { return ""; } };

  const htmlTag = tags(html, "html")[0];
  if (htmlTag?.lang !== "ru") issues.push("html lang is not ru");

  const head = metadataHead(html);
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => decode(m[1]).trim());
  if (titles.length !== 1 || !titles[0]) issues.push("exactly one non-empty <title> is required");

  const descriptions = meta(head, "description");
  if (descriptions.length !== 1 || !descriptions[0].trim()) issues.push("exactly one non-empty meta description is required");

  const robots = meta(head, "robots").join(",").toLowerCase();
  if (expected.indexable && robots.includes("noindex")) issues.push("indexable page carries noindex");
  if (!expected.indexable && !robots.includes("noindex")) issues.push("non-indexable page lacks noindex");

  const canonicals = tags(head, "link").filter((tag) => tag.rel?.split(/\s+/).includes("canonical"));
  const canonical = canonicals[0]?.href ?? "";
  if (expected.indexable) {
    if (canonicals.length !== 1) issues.push("exactly one canonical link is required");
    else {
      let parsed: URL | null = null;
      try { parsed = new URL(canonical); } catch { /* reported below */ }
      if (!parsed || !absoluteHttps(canonical)) issues.push("canonical must be an absolute https URL");
      else {
        if (parsed.search || parsed.hash) issues.push("canonical must not carry a query or fragment");
        if (parsed.pathname.replace(/\/$/, "") !== page.pathname.replace(/\/$/, "")) issues.push("canonical path differs from the page");
      }
    }
  }

  if (expected.indexable) {
    for (const key of ["og:title", "og:description", "og:type", "og:url", "og:locale"]) {
      if (meta(head, key).filter(Boolean).length !== 1) issues.push(`exactly one ${key} is required`);
    }
    if (meta(head, "og:locale")[0] && meta(head, "og:locale")[0] !== "ru_RU") issues.push("og:locale is not ru_RU");
    const ogURL = meta(head, "og:url")[0];
    if (ogURL && canonical && ogURL !== canonical) issues.push("og:url differs from canonical");
  }

  const images = meta(head, "og:image");
  for (const image of images) if (!absoluteHttps(image)) issues.push("og:image must be an absolute https URL");
  if (images.length) {
    const widths = meta(head, "og:image:width"); const heights = meta(head, "og:image:height");
    if (widths.length !== images.length || heights.length !== images.length) issues.push("every og:image needs width and height");
    if (meta(head, "og:image:alt").length !== images.length) issues.push("every og:image needs alt text");
  }

  const ldBlocks = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const block of ldBlocks) {
    try { JSON.parse(block); } catch { issues.push("JSON-LD block is not valid JSON"); }
  }
  if (expected.indexable && !ldBlocks.some((block) => block.includes("\"Organization\""))) issues.push("Organization JSON-LD is missing");
  if (canonical && canonicalOrigin(canonical) !== page.origin) issues.push("canonical points at another origin");
  return issues;
}

/** robots.txt contract for the audited environment. */
export function auditRobots(body: string, production: boolean): string[] {
  const issues: string[] = [];
  const lines = body.split("\n").map((line) => line.trim());
  if (!production) return lines.includes("Disallow: /") ? [] : ["non-production robots must disallow everything"];
  for (const rule of ["Disallow: /account", "Disallow: /admin/", "Disallow: /api/", "Disallow: /checkout/"]) {
    if (!lines.includes(rule)) issues.push(`robots lacks "${rule}"`);
  }
  const clean = lines.filter((line) => line.startsWith("Clean-param:"));
  for (const line of clean) {
    const params = line.slice("Clean-param:".length).trim().split(/\s+/)[0].split("&");
    if (params.some((param) => !/^(utm_[a-z]+|yclid|gclid)$/.test(param))) issues.push("Clean-param covers a content or auth parameter");
  }
  if (!lines.some((line) => line.startsWith("Sitemap: https://"))) issues.push("robots lacks an absolute Sitemap");
  return issues;
}
