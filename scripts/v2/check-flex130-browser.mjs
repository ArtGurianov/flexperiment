// Run after building Platform. Arguments are paths to an installed Playwright module and Chromium.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [playwrightModule, executablePath, mode] = process.argv.slice(2);
assert.ok(playwrightModule && executablePath, "Supply Playwright module and Chromium executable paths");
const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href);
const nativeCheckout = mode === "--my";
assert.ok(mode === undefined || nativeCheckout);
const myOrigin = "https://my.fixture.test";
const lmsReturnOrigin = "https://lms.fixture.test";
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
const my = fileURLToPath(new URL("../../apps/my/", import.meta.url));
const commerce = "http://127.0.0.1:" + fixture.address().port;
let myServer;
let myLocal;
if (nativeCheckout) {
  await once(portProbe.listen(0, "127.0.0.1"), "listening");
  const myPort = portProbe.address().port;
  await new Promise(resolveClose => portProbe.close(resolveClose));
  myLocal = "http://127.0.0.1:" + myPort;
  myServer = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(myPort)], {
    cwd: my, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      MY_ORIGIN: myOrigin, PLATFORM_ORIGIN: lmsReturnOrigin, COMMERCE_INTERNAL_ORIGIN: commerce }, stdio: "inherit",
  });
}
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: platform,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    PLATFORM_ORIGIN: origin, COMMERCE_INTERNAL_ORIGIN: commerce,
    PAYMENT_MODE: "disabled",
    ...(nativeCheckout ? { MY_ORIGIN: myOrigin, MY_IDENTITY_MODE: "on", MY_CHECKOUT_MODE: "native" } : {}),
  },
  stdio: "inherit",
});
let browser;
try {
  for (let retry = 0; retry < 60; retry += 1) {
    if (server.exitCode !== null) throw new Error("Platform exited before accepting requests");
    const lmsReady = await fetch(origin + "/identity").then(r => r.ok, () => false);
    const myReady = !myServer || await fetch(myLocal + "/healthz").then(r => r.ok, () => false);
    if (lmsReady && myReady) break;
    if (retry === 59) throw new Error("Platform did not start");
    await delay(250);
  }
  browser = await chromium.launch({ executablePath, headless: true });
  const desktop = { width: 1440, height: 960 };
  const openPage = async options => {
    const nextPage = await browser.newPage(options);
    await nextPage.route("**/*", async route => {
      const request = new URL(route.request().url());
      if (request.origin === origin) return route.continue();
      if (myLocal && request.origin === myOrigin) {
        const response = await route.fetch({ url: myLocal + request.pathname + request.search, maxRedirects: 0 });
        return route.fulfill({ response });
      }
      if (myLocal && request.origin === lmsReturnOrigin) {
        return route.fulfill({ status: 302, headers: { Location: origin + request.pathname + request.search } });
      }
      return route.abort();
    });
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
  const selectedPaidLesson = gliding + "/lessons/second";
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

  const openProgram = async path => {
    const section = panel(path).locator("details").first();
    if (await section.count() && await section.getAttribute("open") === null) await section.locator("summary").click();
  };
  const selectLesson = async (path, name) => {
    await openProgram(path);
    await panel(path).getByRole("link", { name, exact: true }).click();
  };

  await page.goto(origin);
  await panel("/").locator('img[src="/course-covers/course-main-basics.webp"]').waitFor();
  assert.equal(await panel("/").getByRole("link", { name: "Другой курс" }).count(), 0);
  const privacy = panel("/").getByRole("link", { name: "Конфиденциальность" });
  assert.equal(await privacy.getAttribute("href"), "/legal/privacy");
  await panel("/").getByRole("button", { name: "Настройки cookies" }).click();
  await page.getByRole("dialog", { name: "Настройки аналитики" }).waitFor();
  await page.getByRole("button", { name: "Только необходимые" }).click();
  made.push("homepage policy link and cookie settings are usable");
  await courseLink(basics);
  assert.equal(await panel(basics).locator("details[open]").count(), 0);
  await selectLesson(basics, "Flexing Basics · урок 1");
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
  await selectLesson(basics, "Flexing Basics · урок 2");
  await active(basicsSecond);
  assert.equal(await panel(basicsFirst).isVisible(), false);
  made.push("Back/Forward and explicit course return clear the inactive lesson");

  await panel(basicsSecond).getByRole("link", { name: "К карусели" }).click();
  await active("/");
  assert.equal(await page.locator("[data-home-path*='/lessons/']:visible").count(), 0);
  await panel("/").getByRole("button", { name: "Следующий курс" }).click();
  await courseLink(gliding);
  await selectLesson(gliding, "Gliding · урок 1");
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

  const unknownRoot = await fetch(origin + "/not-a-platform-route");
  assert.equal(unknownRoot.status, 404);
  assert.match(unknownRoot.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await unknownRoot.text(), /404/);
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

  await page.close();
  page = await openPage({ reducedMotion: "reduce", viewport: desktop });

  let signedIn = false;
  let enrolled = false;
  let paid = false;
  let enrollments = 0;
  let paymentAttempts = 0;
  let completionWrites = 0;
  const paidCourse = courses.get("gliding");
  paidCourse.commercial = {
    ...paidCourse.commercial, accessModel: "PAID", offerRef: "course:gliding", priceKopecks: 180000,
  };

  // A local player stub observes mount and teardown. It neither contacts Kinescope nor logs a grant.
  await page.addInitScript(() => {
    window.Kinescope = { IframePlayer: { create: async (id) => {
      const marker = document.createElement("span");
      marker.dataset.fixturePlayer = "";
      marker.textContent = "Fixture player";
      document.getElementById(id).append(marker);
      const on = () => {};
      const noop = async () => {};
      return { Events: {}, on, seekTo: noop, play: noop, getCurrentTime: async () => 0,
        destroy: async () => marker.remove() };
    } } };
  });
  await page.route(origin + "/account-courses.json", route => route.fulfill({ json: { courses: paid ? [{
    courseRef: "gliding", url: gliding, title: "Gliding", access: "ENTITLED", enrollment: null, started: true,
    lessons: [{ lessonRef: "gliding-first", url: glideFirst }, { lessonRef: "gliding-second", url: selectedPaidLesson }],
    continuation: { lesson: { lessonRef: "gliding-first", url: glideFirst }, reason: "CURRENT" },
  }] : [] }, headers: { "Cache-Control": "private, no-store" } }));
  await page.route(origin + "/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (json, status = 200) => route.fulfill({ json, status, headers: { "Cache-Control": "private, no-store" } });
    const facts = ({ courseRef: "basics", courseSlug: "flexing-foundations", enrolledAt: "2026-11-24T00:00:00Z",
      startedAt: "2026-11-24T00:00:00Z", progressPercent: 0 });
    if (path === "/v1/me") return reply({ customer: signedIn ? { id: "synthetic", email_normalized: "synthetic@example.test" } : null,
      entitlements: paid ? [{ scope: "COURSE", course_ref: "gliding" }] : [] });
    if (path === "/v1/me/consents") return reply({ storefront: "COURSES", verifiedAccount: true,
      requiredChoicesConfirmed: true, actionSequence: 0, documents: [] });
    if (path === "/v1/me/orders") return reply({ orders: [] });
    if (path === "/v1/me/free-enrollments/flexing-foundations") {
      return signedIn ? reply({ courseRef: facts.courseRef, courseSlug: facts.courseSlug, courseTitle: "Flexing Basics",
        accessModel: "FREE", enrollment: enrolled ? facts : null, enrollable: !enrolled })
        : reply({ code: "SIGN_IN_REQUIRED" }, 401);
    }
    if (path === "/v1/me/free-enrollments" && request.method() === "POST") {
      const intent = request.postDataJSON();
      assert.deepEqual(intent, { courseSlug: facts.courseSlug, lessonSlug: "second" });
      assert.equal(signedIn, true);
      enrollments += 1;
      enrolled = true;
      return reply({ ...facts, created: enrollments === 1, lessonPath: basicsSecond }, 201);
    }
    if (path.startsWith("/v1/lessons/") && path.endsWith("/playback")) {
      if (!signedIn) return reply({ decision: "SIGN_IN_REQUIRED" }, 401);
      if (path.includes("/flexing-foundations-") && !enrolled) return reply({ decision: "ENROLLMENT_REQUIRED" }, 403);
      if (path.includes("/gliding-") && !paid) return paidCourse.commercial.saleMode === "CLOSED"
        ? reply({ decision: "NOT_FOR_SALE" }, 403)
        : reply({ decision: "PURCHASE_REQUIRED" }, 402);
      return reply({ mode: "protected", videoId: "fixture-video", resumeAt: 0, token: "synthetic",
        expiresAt: new Date(Date.now() + 180_000).toISOString() });
    }
    if (path.endsWith("/completion")) {
      if (!signedIn || (!paid && !enrolled)) return reply({}, 403);
      if (request.method() === "POST") completionWrites += 1;
      return reply({ firstCompletedAt: completionWrites ? "2026-11-24T00:00:00.000Z" : null, progressPercent: completionWrites ? 50 : 0 });
    }
    if (path === "/v1/checkout/handoff") {
      assert.deepEqual(request.postDataJSON(), { returnPath: selectedPaidLesson, storefront: "COURSES" });
      return reply({ required: false });
    }
    if (path === "/v1/checkout/preview") {
      assert.equal(request.postDataJSON().offerRef, paidCourse.commercial.offerRef);
      return reply({ quoteId: "local-review", state: "PRICE_REVIEW_REQUIRED", baseAmountKopecks: 180000,
        merchantDiscountKopecks: 0, referralDiscountKopecks: 0, discountKopecks: 0, finalAmountKopecks: 180000,
        merchantPromotionCode: null, checkoutCodeOutcome: "NONE" });
    }
    if (path === "/v1/checkout" && request.method() === "POST") {
      assert.equal(request.postDataJSON().quoteId, "local-review");
      paymentAttempts += 1;
      paid = true;
      return reply({ state: "PAID" });
    }
    return reply({}, 404);
  });

  if (nativeCheckout) {
    const { lms } = JSON.parse(readFileSync(new URL("../../apps/my/test/fixtures/checkout/commerce-answers.json", import.meta.url), "utf8"));
    const syntheticOrder = "ord-course-0001";
    await page.route(url => url.origin === myOrigin && url.pathname.startsWith("/v1/checkout"), async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/checkout/preview") {
        assert.deepEqual(request.postDataJSON(), { offerRef: "course:gliding" });
        return route.fulfill({ json: { ...lms.preview, offerRef: "course:gliding",
          expiresAt: new Date(Date.now() + 600_000).toISOString() } });
      }
      if (path === "/v1/checkout") {
        const body = request.postDataJSON();
        assert.match(body.returnPath, /^\/checkout\/[A-Za-z0-9_-]+$/);
        assert.equal(body.legalAcceptance.accepted, true);
        paymentAttempts += 1;
        return route.fulfill({ status: 201, json: { orderPublicId: syntheticOrder, contour: "NATIVE",
          payment: "AWAITING_PAYMENT", paymentUrl: myOrigin + body.returnPath + "?order=" + syntheticOrder } });
      }
      assert.equal(path, "/v1/checkout/" + syntheticOrder);
      paid = true;
      return route.fulfill({ json: { orderPublicId: syntheticOrder, contour: "NATIVE", payment: "ACCESS_GRANTED" } });
    });
  }

  await page.goto(origin);
  await courseLink(basics);
  await panel(basics).getByRole("button", { name: /Записаться бесплатно/ }).waitFor();
  assert.equal(enrollments, 0);
  await selectLesson(basics, "Flexing Basics · урок 2");
  await active(basicsSecond);
  await panel(basicsSecond).getByRole("button", { name: /Записаться бесплатно/ }).click();
  await page.waitForURL(origin + "/account?enroll=flexing-foundations&lesson=second");
  assert.equal(enrollments, 0);
  signedIn = true;
  await page.reload();
  await page.waitForURL(origin + basicsSecond);
  await page.locator("[data-fixture-player]").waitFor();
  assert.equal(enrollments, 1);
  await page.reload();
  await page.locator("[data-fixture-player]").waitFor();
  assert.equal(enrollments, 1);
  made.push("carousel → guest enrollment intent for the selected second lesson → synthetic sign-in → protected second lesson");

  const selectPaid = async () => {
    await page.goto(origin);
    await panel("/").getByRole("button", { name: "Следующий курс" }).click();
    await courseLink(gliding);
    await selectLesson(gliding, "Gliding · урок 2");
    await active(selectedPaidLesson);
  };
  await selectPaid();
  await panel(selectedPaidLesson).getByText("Продажи курса закрыты.").waitFor();
  assert.equal(await panel(selectedPaidLesson).getByRole("button", { name: /Купить курс/ }).count(), 0);
  paidCourse.commercial.saleMode = "PUBLIC";
  await selectPaid();
  const offer = page.getByRole("dialog", { name: "Условия доступа к уроку" });
  await offer.waitFor();
  await page.keyboard.press("Escape");
  await offer.waitFor({ state: "hidden" });
  await page.goBack();
  await active(gliding);
  await page.goForward();
  await active(selectedPaidLesson);
  const purchase = panel(selectedPaidLesson).getByRole(nativeCheckout ? "link" : "button", { name: /Купить/ });
  await purchase.waitFor();
  assert.equal(await offer.isVisible(), false);
  await purchase.click();
  if (nativeCheckout) {
    await page.waitForURL(url => url.origin === myOrigin && url.searchParams.get("lesson") === selectedPaidLesson);
    await page.locator('input[name="terms"]').check();
    await page.locator('button[type="submit"]').click();
    const back = page.getByRole("link", { name: /Вернуться к уроку/ });
    await back.waitFor();
    await page.reload();
    assert.equal(await back.getAttribute("href"), lmsReturnOrigin + selectedPaidLesson);
    await back.click();
  } else {
    await panel(selectedPaidLesson).getByRole("button", { name: /Подтвердить и оплатить/ }).click();
  }
  await page.getByRole("heading", { name: "Gliding · урок 2", level: 1 }).waitFor();
  await page.locator("[data-fixture-player]").waitFor();
  assert.equal(page.url(), origin + selectedPaidLesson);
  assert.equal(paymentAttempts, 1);
  made.push("carousel → closed or payable lesson → synthetic checkout → same canonical protected lesson");

  await selectPaid();
  await panel(selectedPaidLesson).locator("[data-fixture-player]").waitFor();
  await page.goBack();
  await active(gliding);
  assert.equal(await page.locator("[data-fixture-player]").count(), 0);
  assert.equal(await panel(gliding).locator("details[open]").count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), selectedPaidLesson);
  made.push("leaving an intercepted protected lesson destroys the player and restores program and focus");

  await panel(gliding).getByRole("link", { name: "Продолжить", exact: true }).click();
  await active(glideFirst);
  await panel(glideFirst).getByRole("button", { name: "Отметить пройденным" }).click();
  await panel(glideFirst).getByText("Пройдено", { exact: true }).waitFor();
  assert.equal(completionWrites, 1);
  made.push("paid started course continues to Commerce target; intercepted lesson records completion explicitly");

  console.log(JSON.stringify({ result: "PASS", mode: nativeCheckout ? "MY" : "Stage A", scenarios: made }));
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
  if (myServer?.exitCode === null) myServer.kill("SIGTERM");
  await new Promise(resolveClose => fixture.close(resolveClose));
}
