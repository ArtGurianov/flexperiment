// FLEX-70 SEO audit fixture: a loopback-only synthetic Commerce catalogue (no network, no real data).
// One course with an activated FLEX-63 image, one without, and a public noindex lesson.
import http from "node:http";
const m = "https://flexperiment.s3.cloud.ru/course-media/public/course-one/abc";
const course = (slug, image) => ({ courseRef: `course-${slug}`, version: 1, title: `Курс ${slug}`, slug, summary: `Описание курса ${slug}`,
  description: null, seo: null, publicContentUpdatedAt: "2026-11-20T10:00:00.000Z", ...(image ? { image } : {}) });
const image = { alt: "Танцор в стойке", variants: [
  { name: "card", url: `${m}/card.webp`, width: 960, height: 640 },
  { name: "hero", url: `${m}/hero.webp`, width: 1920, height: 1080 },
  { name: "og", url: `${m}/og.webp`, width: 1200, height: 630 }] };
const commercial = (r) => ({ courseRef: r, offerRef: null, accessModel: "FREE", saleMode: "CLOSED", priceKopecks: null, withdrawn: false });
const outline = { sections: [{ sectionRef: "s", title: "Раздел", position: 0 }], lessons: [{ lessonRef: "l", sectionRef: "s", title: "Урок", slug: "intro", position: 0, freePreview: true }] };
const detail = (slug, img) => ({ course: course(slug, img), commercial: commercial(`course-${slug}`), outline });
const routes = {
  "/v1/courses": { courses: [detail("one", image), detail("two")] },
  "/v1/courses/one": detail("one", image), "/v1/courses/two": detail("two"),
  "/v1/courses/one/lessons/intro": { ...detail("one", image), section: outline.sections[0], lesson: { ...outline.lessons[0], description: null, seo: null } },
};
http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname; const body = routes[path];
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? { code: "NOT_FOUND" }));
}).listen(Number(process.env.SEO_FIXTURE_PORT ?? 3912), "127.0.0.1");
