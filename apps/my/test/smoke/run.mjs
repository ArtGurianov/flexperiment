// FLEX-122 local smoke: drives /checkout/<intent> in Chromium for LMS and LAB.
// The container's preinstalled Playwright: PLAYWRIGHT_MODULE=$(npm root -g)/playwright/index.js
const { chromium } = (await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")).default;
const out = process.argv[2];
const MY = "http://localhost:3003";
const id = (ref) => "offer" + Buffer.from(ref).toString("base64url");
const results = [];
const check = (name, cond) => { results.push(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) process.exitCode = 1; };

try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const phase = () => page.locator("section[data-phase]").first().getAttribute("data-phase");
  const waitPhase = async (p, extra = "") => page.waitForSelector(`section[data-phase="${p}"]${extra}`, { timeout: 15000 });

  // LMS: anonymous → sign-in link with my return target; then signed in → review → accept → return → access.
  await page.goto(`${MY}/checkout/${id("course:one")}?type=course`);
  await waitPhase("SIGN_IN");
  const href = await page.locator("a").first().getAttribute("href");
  check("LMS anonymous → sign-in with next=/checkout/<id>", href === `/sign-in?next=${encodeURIComponent("/checkout/" + id("course:one"))}`);
  await fetch("http://127.0.0.1:4999/__signin");
  await page.reload();
  await waitPhase("REVIEW", '[data-kind="COURSE"]');
  await page.screenshot({ path: `${out}/lms-review.png` });
  check("LMS submit disabled before acceptance", await page.locator('button[type="submit"]').isDisabled());
  await page.check('input[name="terms"]');
  await page.click('button[type="submit"]');
  await waitPhase("STATUS", '[data-payment="ACCESS_GRANTED"]');
  check("LMS return: address bar cleaned of ?order=", !page.url().includes("order="));
  await page.screenshot({ path: `${out}/lms-access.png` });
  await page.reload();
  await waitPhase("STATUS", '[data-payment="ACCESS_GRANTED"]');
  check("LMS refresh after return keeps the order status", true);

  // Foreign order in the return URL.
  await page.goto(`${MY}/checkout/${id("course:one")}?order=ord-someone-else`);
  await waitPhase("ORDER_NOT_FOUND");
  check("foreign ?order= → not found", true);

  // Tampered intent id → 404 page, no Commerce call.
  const tampered = await page.goto(`${MY}/checkout/offerZXZpbDp0aGluZw`);
  check("tampered intent id → 404", tampered.status() === 404);

  // LAB: three acceptances, ticket after status.
  await page.goto(`${MY}/checkout/${id("lab:november")}?type=course`); // wrong type hint: server kind wins
  await waitPhase("REVIEW", '[data-kind="LAB"]');
  await page.screenshot({ path: `${out}/lab-review.png` });
  await page.check('input[name="terms"]');
  await page.check('input[name="personalData"]');
  check("LAB submit disabled until all three acceptances", await page.locator('button[type="submit"]').isDisabled());
  await page.check('input[name="receiptContact"]');
  await page.click('button[type="submit"]');
  await waitPhase("STATUS", '[data-payment="TICKET_ISSUED"]');
  await page.screenshot({ path: `${out}/lab-ticket.png` });
  check("LAB ticket issued after authoritative status", true);

  // LAB closed sales.
  await page.goto(`${MY}/checkout/${id("lab:closed")}`);
  await waitPhase("UNAVAILABLE");
  check("LAB closed sales text", (await page.textContent("section")).includes("Продажа билетов на события сейчас закрыта"));
  await page.screenshot({ path: `${out}/lab-closed.png` });

  const storage = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
  check("sessionStorage has no e-mail or amounts", !/@|Kopecks|Acceptance/.test(storage));
  const log = await (await fetch("http://127.0.0.1:4999/__log")).json();
  check("every upstream call carries x-forwarded-host=localhost:3003", log.filter((l) => l.url.startsWith("/v1")).every((l) => l.host === "localhost:3003"));
  check("preview bodies carry only offerRef", log.filter((l) => l.url === "/v1/checkout/preview").every((l) => Object.keys(l.body).join() === "offerRef"));
  check("exactly one confirm per purchase", log.filter((l) => l.url === "/v1/checkout").length === 2);
  console.log(results.join("\n"));
  console.log(`phase at end: ${await phase()}`);
  await browser.close();
} catch (error) { console.error(error); process.exit(1); }
