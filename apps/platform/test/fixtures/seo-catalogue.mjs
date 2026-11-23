// FLEX-70 SEO audit fixture: a loopback-only synthetic Commerce catalogue (no network, no real data).
// One course whose courseRef has FLEX-63 Stage A artwork, one without (text fallback), and a public noindex lesson.
import http from "node:http";
// "one" uses a courseRef bound in lib/public-media.ts COURSE_IMAGE_MANIFEST; "two" has no artwork (text fallback).
const course = (slug, courseRef) => ({ courseRef, version: 1, title: `Курс ${slug}`, slug, summary: `Описание курса ${slug}`,
  description: null, seo: null, publicContentUpdatedAt: "2026-11-20T10:00:00.000Z" });
const commercial = (r) => ({ courseRef: r, offerRef: null, accessModel: "FREE", saleMode: "CLOSED", priceKopecks: null, withdrawn: false });
const outline = { sections: [{ sectionRef: "s", title: "Раздел", position: 0 }], lessons: [{ lessonRef: "l", sectionRef: "s", title: "Урок", slug: "intro", position: 0, freePreview: true }] };
const refs = { one: "basics", two: "course-two" };
const detail = (slug) => ({ course: course(slug, refs[slug]), commercial: commercial(refs[slug]), outline });
const routes = {
  "/v1/courses": { courses: [detail("one"), detail("two")] },
  "/v1/courses/one": detail("one"), "/v1/courses/two": detail("two"),
  "/v1/courses/one/lessons/intro": { ...detail("one"), section: outline.sections[0], lesson: { ...outline.lessons[0], description: null, seo: null } },
};
http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname; const body = routes[path];
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? { code: "NOT_FOUND" }));
}).listen(Number(process.env.SEO_FIXTURE_PORT ?? 3912), "127.0.0.1");
