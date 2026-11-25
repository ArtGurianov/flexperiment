// FLEX-16: exercise the HTTP response from a production Next build on loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import nextCacheKey from "next/dist/client/components/router-reducer/set-cache-busting-search-param.js";

const platform = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PLATFORM_LEGAL_SMOKE_PORT ?? "3913");
const origin = `http://127.0.0.1:${port}`;
const legalPath = "/v1/legal/current?storefront=COURSES";
const privacyDatePath = "/legal/privacy/effective-at";
const titles = {
  privacy: ["privacy", "Политика конфиденциальности"],
  "personal-data": ["personal_data", "Согласие на обработку персональных данных"],
  "account-terms": ["account_terms", "Условия аккаунта"],
  marketing: ["marketing_consent", "Согласие на рекламную рассылку Flexperiment"],
};
const hash = data => createHash("sha256").update(data).digest("hex");

let edition;
let malformed = false;
let legalReads = 0;
let anonymousReads = 0;
let contextTouches = 0;
const sourceBytes = new Map();
const commerce = createServer((req, res) => {
  if (sourceBytes.has(req.url)) return res.writeHead(200).end(sourceBytes.get(req.url));
  if (req.url === "/v1/browser-context/touch" && req.method === "POST") {
    contextTouches++;
    return res.writeHead(204).end();
  }
  if (req.url !== legalPath) return res.writeHead(404).end();
  legalReads++;
  if (!req.headers.cookie && !req.headers.authorization && !req.headers["x-flexperiment-legal-page"]) anonymousReads++;
  res.setHeader("content-type", "application/json");
  if (malformed) return res.writeHead(200).end("{");
  if (!edition) return res.writeHead(404).end(JSON.stringify({ code: "LEGAL_RELEASE_NOT_FOUND" }));
  res.end(JSON.stringify(edition));
});
await once(commerce.listen(0, "127.0.0.1"), "listening");
const upstream = `http://127.0.0.1:${commerce.address().port}`;
const makeEdition = (version, effectiveAt) => ({
  version, effectiveAt, manifest: { stage: "A", documents: Object.values(titles).map(([kind, title]) => {
    const path = `/source/${version}/${kind}.md`;
    const bytes = Buffer.from(`# ${title}\r\n\r\nСинтетическая редакция ${version}.\r\n`);
    sourceBytes.set(path, bytes);
    return { kind, version, sha256: hash(bytes), url: `https://documents.example.test${path}` };
  }) },
});
const app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: platform, stdio: "ignore", env: {
    PATH: process.env.PATH,
    COMMERCE_INTERNAL_ORIGIN: upstream,
    PLATFORM_ORIGIN: origin,
    SOURCE_COMMIT: process.env.SOURCE_COMMIT ?? "development",
  },
});
const request = async (path, status, headers = {}) => {
  const response = await fetch(origin + path, {
    redirect: "manual", signal: AbortSignal.timeout(6000),
    headers: { "user-agent": "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36", ...headers },
  });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get("location"), null, path);
  return response;
};
const navigate = async (status) => {
  const target = new URL("/legal/privacy", origin);
  const headers = { rsc: "1" };
  await nextCacheKey.setCacheBustingSearchParam(target, headers);
  return request(target.pathname + target.search, status, headers);
};
const assertEdition = (body, document) => {
  for (const value of [document.version, document.sha256, document.url, edition.effectiveAt]) assert(body.includes(value));
  assert(!body.includes("spoofed-document"));
};

try {
  let started = false;
  for (let i = 0; i < 100 && app.exitCode === null; i++) {
    try {
      const identity = await (await request("/identity", 200)).json();
      if (identity.service === "platform" && identity.sourceCommit === (process.env.SOURCE_COMMIT ?? "development")) {
        started = true;
        break;
      }
    } catch { /* Startup is bounded. */ }
    await setTimeout(100);
  }
  assert(started, "Built Platform did not start with the expected identity");
  assert.deepEqual(await (await request(legalPath, 404)).json(), { code: "LEGAL_RELEASE_NOT_FOUND" });
  await (await request("/legal/privacy", 404)).text();
  const beforeUnknown = legalReads;
  await (await request("/legal/constructor", 404)).text();
  assert.equal(legalReads, beforeUnknown);

  for (const [version, utc, date] of [
    ["edition-1", "2026-11-23T20:59:59.999Z", "23 ноября 2026 г."],
    ["edition-2", "2026-11-23T21:00:00.000Z", "24 ноября 2026 г."],
  ]) {
    edition = makeEdition(version, utc);
    assert.deepEqual(await (await request(legalPath, 200)).json(), edition);
    for (const [slug, [kind, title]] of Object.entries(titles)) {
      const document = edition.manifest.documents.find(item => item.kind === kind);
      const html = await (await request(`/legal/${slug}`, 200, { "x-flexperiment-legal-page": "spoofed-document" })).text();
      assertEdition(html, document);
      assert(html.includes(`<h1>${title}</h1>`));
      assert(html.includes(`<time dateTime="${utc}">${date}</time>`));
      assert(html.includes(`href="${document.url}"`));
      const source = await fetch(upstream + new URL(document.url).pathname);
      assert.equal(source.status, 200);
      assert.equal(hash(Buffer.from(await source.arrayBuffer())), document.sha256);
    }
    if (version === "edition-1") {
      const beforeDate = legalReads;
      assert((await (await request("/", 200)).text()).includes(`<time dateTime="${utc}">${date}</time>`));
      const dateResponse = await request(privacyDatePath, 200);
      assert.equal(dateResponse.headers.get("cache-control"), "no-store");
      assert.deepEqual(await dateResponse.json(), { effectiveAt: utc });
      assert.equal(legalReads, beforeDate + 1, "homepage and analytics share one cached Commerce lookup");
    }
    const flight = await navigate(200);
    assert.match(flight.headers.get("content-type") ?? "", /text\/x-component/);
    assertEdition(await flight.text(), edition.manifest.documents[0]);
  }

  const contextCookie = `__Host-flx-ctx-lms=${"c".repeat(43)}`;
  await (await request("/legal/privacy", 200, { cookie: contextCookie, purpose: "prefetch" })).text();
  assert.equal(contextTouches, 0, "speculative legal requests must not touch browser context");
  await (await request("/legal/privacy", 200, { cookie: contextCookie })).text();
  for (let attempt = 0; attempt < 50 && contextTouches === 0; attempt++) await setTimeout(20);
  assert.equal(contextTouches, 1, "a normal legal page view still touches browser context");

  assert.deepEqual(await (await request(privacyDatePath, 200)).json(), { effectiveAt: "2026-11-23T20:59:59.999Z" });
  await setTimeout(15_200);
  assert.deepEqual(await (await request(privacyDatePath, 200)).json(), { effectiveAt: edition.effectiveAt });
  assert((await (await request("/", 200)).text()).includes('<time dateTime="2026-11-23T21:00:00.000Z">24 ноября 2026 г.</time>'));

  edition = undefined;
  await (await navigate(404)).text();
  malformed = true;
  await (await request("/legal/privacy", 503)).text();
  assert.equal(legalReads, anonymousReads);
  await new Promise((resolve, reject) => commerce.close(error => error ? reject(error) : resolve()));
  await (await request("/legal/privacy", 503)).text();
  console.log("Platform legal smoke PASS · SSR, RSC, original hashes, rotation, shared link-date cache, browser context, 404 and 503");
} finally {
  app.kill();
  commerce.close();
}
