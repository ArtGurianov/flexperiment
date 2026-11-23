import { describe, expect, it } from "vitest";
import { auditRenderedPage, auditRobots, renderedOgImages } from "../lib/seo-audit";
import { robotsTxt } from "../lib/seo";

const origin = "https://flexperiment.ru";
const page = (head: string, lang = "ru") => `<!DOCTYPE html><html lang="${lang}"><head><meta charSet="utf-8"/>${head}</head><body>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Flexperiment"}</script></body></html>`;
const indexableHead = (extra = "") => `<title>Курс брейкинга</title><meta name="description" content="Описание &amp; программа"/>
<link rel="canonical" href="${origin}/courses/one"/><meta property="og:title" content="Курс"/><meta property="og:description" content="Описание"/>
<meta property="og:url" content="${origin}/courses/one"/><meta property="og:locale" content="ru_RU"/><meta property="og:type" content="website"/>${extra}`;

describe("rendered SEO audit", () => {
  it("passes a complete indexable course page with an OG image", () => {
    const html = page(indexableHead(`<meta property="og:image" content="https://flexperiment.s3.cloud.ru/x/og.webp"/>
<meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta property="og:image:alt" content="Танцор"/>`));
    expect(auditRenderedPage(html, { url: `${origin}/courses/one`, indexable: true })).toEqual([]);
  });

  it("passes a public lesson page that is noindex, follow", () => {
    const html = page(`<title>Урок</title><meta name="description" content="Урок курса"/><meta name="robots" content="noindex, follow"/>
<link rel="canonical" href="${origin}/courses/one/lessons/intro"/>`);
    expect(auditRenderedPage(html, { url: `${origin}/courses/one/lessons/intro`, indexable: false })).toEqual([]);
  });

  it("ignores body tags and head comments or scripts when auditing metadata", () => {
    const bodyTags = indexableHead(`<meta name="robots" content="noindex"/><meta property="og:image" content="${origin}/body.webp"/>`);
    const html = page(`<!-- <title>Comment</title> --><script>const title = "<title>Script</title>";</script>`)
      .replace("<body>", `<body>${bodyTags}`);
    expect(auditRenderedPage(html, { url: `${origin}/courses/one`, indexable: true })).toEqual(expect.arrayContaining([
      "exactly one non-empty <title> is required", "exactly one non-empty meta description is required",
      "exactly one canonical link is required", "exactly one og:title is required",
    ]));
    expect(auditRenderedPage(html, { url: `${origin}/courses/one`, indexable: false })).toContain("non-indexable page lacks noindex");
    expect(renderedOgImages(html)).toEqual([]);
  });

  it("reports each broken contract", () => {
    const html = page(`<title></title><meta name="robots" content="noindex"/>
<link rel="canonical" href="http://other.test/courses/two?utm_source=x"/><meta property="og:locale" content="en_US"/>
<meta property="og:image" content="/relative.webp"/><script type="application/ld+json">{bad</script>`, "en");
    expect(auditRenderedPage(html, { url: `${origin}/courses/one`, indexable: true })).toEqual(expect.arrayContaining([
      "html lang is not ru", "exactly one non-empty <title> is required", "exactly one non-empty meta description is required",
      "indexable page carries noindex", "canonical must be an absolute https URL", "exactly one og:title is required",
      "og:locale is not ru_RU", "og:image must be an absolute https URL", "every og:image needs width and height",
      "JSON-LD block is not valid JSON", "canonical points at another origin",
    ]));
    expect(auditRenderedPage(page(indexableHead()), { url: `${origin}/courses/one`, indexable: false }))
      .toContain("non-indexable page lacks noindex");
  });

  it("accepts the shipped robots for both environments and rejects a Clean-param on auth parameters", () => {
    expect(auditRobots(robotsTxt(origin, "production"), true)).toEqual([]);
    expect(auditRobots(robotsTxt(origin, "staging"), false)).toEqual([]);
    expect(auditRobots(robotsTxt(origin, "production").replace("gclid", "gclid&rt&state"), true))
      .toContain("Clean-param covers a content or auth parameter");
    expect(auditRobots("User-agent: *\nAllow: /\n", false)).toEqual(["non-production robots must disallow everything"]);
  });
});
