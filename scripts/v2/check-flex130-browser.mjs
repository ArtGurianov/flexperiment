// Run after building Platform. Arguments are paths to an installed Playwright module and Chromium.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [playwrightModule, executablePath] = process.argv.slice(2);
assert.ok(playwrightModule && executablePath, "Supply Playwright module and Chromium executable paths");
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);
const platform = fileURLToPath(new URL("../../apps/platform/", import.meta.url));

function courseFixture(courseRef, slug, title) {
  const section = { sectionRef: slug + "-section", title: "Программа " + title, position: 1 };
  return {
    course: {
      courseRef, slug, title,
      summary: courseRef === "basics"
        ? "Длинная программа курса для проверки прокрутки перед переходом. ".repeat(26).trim()
        : title + " — данные проверки маршрутов",
      version: 1, description: null, seo: null, publicContentUpdatedAt: "2026-11-24T00:00:00Z",
    },
    commercial: { courseRef, offerRef: null, accessModel: "FREE", withdrawn: false, saleMode: "CLOSED", priceKopecks: null },
    outline: {
      sections: [section],
      lessons: ["first", "second"].map((lessonSlug, index) => ({
        lessonRef: slug + "-" + lessonSlug, sectionRef: section.sectionRef, slug: lessonSlug,
        title: title + " · урок " + (index + 1), position: index + 1, freePreview: false,
      })),
    },
  };
}

const courses = new Map([
  ["groove", courseFixture("unfeatured", "groove", "Другой курс")],
  ["gliding", courseFixture("gliding", "gliding", "Gliding")],
  ["flexing-foundations", courseFixture("basics", "flexing-foundations", "Flexing Basics")],
]);
const fixture = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const match = /^\/v1\/courses\/([^/]+)(?:\/lessons\/([^/]+))?$/.exec(path);
  const course = match && courses.get(match[1]);
  const lesson = course && match[2] && course.outline.lessons.find(item => item.slug === match[2]);
  const data = path === "/v1/courses" ? { courses: [...courses.values()] }
    : lesson ? { ...course, lesson, section: course.outline.sections[0] }
    : course && !match[2] ? course : null;
  res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data ?? { code: "FIXTURE_NOT_FOUND" }));
});
await once(fixture.listen(0, "127.0.0.1"), "listening");
const portProbe = createServer();
await once(portProbe.listen(0, "127.0.0.1"), "listening");
const port = portProbe.address().port;
await new Promise(resolveClose => portProbe.close(resolveClose));
const origin = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: platform,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    PLATFORM_ORIGIN: origin, COMMERCE_INTERNAL_ORIGIN: "http://127.0.0.1:" + fixture.address().port,
    PAYMENT_MODE: "disabled",
  },
  stdio: "inherit",
});
let browser;
try {
  for (let retry = 0; retry < 60; retry += 1) {
    if (server.exitCode !== null) throw new Error("Platform exited before accepting requests");
    if (await fetch(origin + "/identity").then(r => r.ok, () => false)) break;
    if (retry === 59) throw new Error("Platform did not start");
    await delay(250);
  }
  browser = await chromium.launch({ executablePath, headless: true });
  const desktop = { width: 1440, height: 960 };
  const openPage = async options => {
    const nextPage = await browser.newPage(options);
    await nextPage.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    nextPage.setDefaultTimeout(8000);
    return nextPage;
  };
  let page = await openPage({ reducedMotion: "reduce", viewport: desktop });
  const made = [];
  const basics = "/courses/flexing-foundations";
  const basicsFirst = basics + "/lessons/first";
  const basicsSecond = basics + "/lessons/second";
  const gliding = "/courses/gliding";
  const glideFirst = gliding + "/lessons/first";
  const bundle = "/all-courses";
  const bundleLink = () => panel(basics).getByRole("link", { name: "Все курсы комплектом" });
  const panel = path => page.locator(`[data-home-path="${path}"]`);
  const active = async path => {
    await page.waitForURL(origin + path);
    await panel(path).waitFor();
    await page.waitForFunction(p => {
      const panels = [...document.querySelectorAll("[data-home-path]")].filter(item => item.offsetHeight > 0);
      const [element, duplicate] = panels.filter(item => item.dataset.homePath === p);
      return element && !duplicate && !element.inert
        && Math.abs(element.getBoundingClientRect().top) <= 2
        && panels.every(item => item === element || item.inert);
    }, path, { timeout: 6000 });
  };
  const courseLink = async path => {
    const link = page.locator(`a[href="${path}"]`).filter({ hasText: "Подробнее" });
    await link.click();
    await active(path);
  };

  await page.goto(origin);
  await panel("/").locator('img[src="/course-covers/course-main-basics.webp"]').waitFor();
  assert.equal(await panel("/").getByRole("link", { name: "Другой курс" }).count(), 0);
  await courseLink(basics);
  await panel(basics).getByRole("link", { name: "Flexing Basics · урок 1" }).click();
  await active(basicsFirst);
  assert.equal(await panel(basics).count(), 1);
  assert.equal(await page.locator("[data-home-path*='/lessons/']:visible").count(), 1);
  await page.keyboard.press("PageDown");
  assert.equal(page.url(), origin + basicsFirst);
  made.push("carousel → intercepted canonical course → intercepted first lesson");

  await page.goBack();
  await active(basics);
  assert.equal(await page.locator("[data-home-path*='/lessons/']:visible").count(), 0);
  await page.goForward();
  await active(basicsFirst);
  await panel(basicsFirst).getByRole("link", { name: "К курсу" }).click();
  await active(basics);
  await panel(basics).getByRole("link", { name: "Flexing Basics · урок 2" }).click();
  await active(basicsSecond);
  assert.equal(await panel(basicsFirst).isVisible(), false);
  made.push("Back/Forward and explicit course return clear the inactive lesson");

  await panel(basicsSecond).getByRole("link", { name: "К карусели" }).click();
  await active("/");
  assert.equal(await page.locator("[data-home-path*='/lessons/']:visible").count(), 0);
  await panel("/").getByRole("button", { name: "Следующий курс" }).click();
  await courseLink(gliding);
  await panel(gliding).getByRole("link", { name: "Gliding · урок 1" }).click();
  await active(glideFirst);
  assert.equal(await panel(basics).isVisible(), false);
  assert.equal(await page.locator("[data-home-path*='/lessons/']:visible").count(), 1);
  made.push("switching courses clears the old course and its lesson");

  await page.reload();
  await page.getByRole("heading", { name: "Gliding · урок 1", level: 1 }).waitFor();
  assert.equal(await panel("/").count(), 0);
  await page.goto(origin + basics);
  await page.getByRole("heading", { name: "Flexing Basics", level: 1 }).waitFor();
  assert.equal(await panel("/").count(), 0);
  await page.goto(origin + basicsSecond);
  await page.getByRole("heading", { name: "Flexing Basics · урок 2", level: 1 }).waitFor();
  assert.equal(await panel("/").count(), 0);
  made.push("reload and direct course/lesson URLs open standalone pages");

  const alias = await fetch(origin + "/basics", { redirect: "manual" });
  assert.equal(alias.status, 308);
  assert.equal(alias.headers.get("location"), basics);
  await page.goto(origin + "/basics");
  assert.equal(page.url(), origin + basics);
  await page.getByRole("heading", { name: "Flexing Basics", level: 1 }).waitFor();
  assert.equal(await panel("/").count(), 0);
  const missingAlias = await fetch(origin + "/bonebreaking", { redirect: "manual" });
  assert.equal(missingAlias.status, 404);
  made.push("legacy alias and cover follow the courseRef despite a conflicting legacy slug");

  const unknown = await fetch(origin + "/not-a-platform-route/unknown");
  assert.equal(unknown.status, 404);
  const retiredWriter = await fetch(origin + "/internal/revalidate", { method: "POST" });
  assert.equal(retiredWriter.status, 404);
  made.push("unmatched URLs and the retired writer path still return HTTP 404");

  await page.close();
  page = await openPage({ reducedMotion: "no-preference", viewport: desktop });
  const scrollPanel = async pixels => {
    await page.mouse.move(desktop.width / 2, desktop.height / 2);
    await page.mouse.wheel(0, pixels);
  };

  await page.goto(origin);
  await courseLink(basics);
  await bundleLink().click();
  await active(bundle);
  const headings = page.getByRole("heading", { name: "Хотите все курсы одним комплектом?" });
  assert.equal(await headings.count(), 1);
  await page.goBack();
  await active(basics);
  assert.equal(await panel(bundle).isVisible(), false);
  await page.goForward();
  await active(bundle);
  await scrollPanel(-720);
  await active(basics);
  await bundleLink().click();
  await active(bundle);
  await panel(bundle).getByRole("link", { name: "К карусели" }).click();
  await active("/");
  assert.equal(await panel(bundle).isVisible(), false);
  assert.equal(await panel(basics).isVisible(), false);
  await panel("/").getByRole("button", { name: "Следующий курс" }).click();
  await courseLink(gliding);
  await page.goBack();
  await active("/");
  await page.goForward();
  await active(gliding);
  assert.equal(await panel(basics).isVisible(), false);
  assert.equal(await panel(bundle).isVisible(), false);
  made.push("animated desktop: bundle history, reverse wheel, smooth carousel return and course switch");

  await page.goto(origin + bundle);
  await active(bundle);
  assert.equal(await headings.count(), 1);
  assert.equal(await panel("/").count(), 0);
  await page.reload();
  await active(bundle);
  assert.equal(await headings.count(), 1);
  assert.equal(await panel("/").count(), 0);
  assert.equal(await panel(basics).count(), 0);
  made.push("bundle opens directly and reloads with one active section");

  await page.close();
  page = await openPage({
    hasTouch: true, isMobile: true, reducedMotion: "no-preference", viewport: { width: 390, height: 700 },
  });
  const touch = await page.context().newCDPSession(page);
  const swipeUp = async () => {
    const x = 195;
    const startY = 530;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
    for (let distance = 24; distance <= 240; distance += 24) {
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: startY - distance }] });
      await delay(20);
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await page.goto(origin);
  await courseLink(basics);
  assert.ok(await panel(basics).evaluate(item => item.scrollHeight > item.clientHeight + 240));
  await swipeUp();
  await page.waitForFunction(() => document.querySelector('[data-home-path="/courses/flexing-foundations"]').scrollTop > 20);
  assert.equal(page.url(), origin + basics);
  await panel(basics).evaluate(item => item.scrollTo({ top: item.scrollHeight, behavior: "instant" }));
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-home-path="/courses/flexing-foundations"]');
    return panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 1;
  });
  await swipeUp();
  await active(bundle);
  await panel(bundle).getByRole("link", { name: "К карусели" }).tap();
  await active("/");
  assert.equal(await panel(bundle).isVisible(), false);
  made.push("mobile touch: scrolling long course stays on the route, edge swipe opens bundle and tap returns");

  console.log(JSON.stringify({ result: "PASS", scenarios: made }));
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
  await new Promise(resolveClose => fixture.close(resolveClose));
}
