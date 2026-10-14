// Internal synthetic Control Room smoke. Credentials arrive only on stdin.
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const base = 'http://admin';
const headers = { host: 'canary-admin.flexperiment.ru', origin: 'https://canary-admin.flexperiment.ru', 'content-type': 'application/json' };
const retired = [
  ['POST', '/v1/internal/course-manifests'], ['POST', '/v1/internal/access-overrides'],
  ['GET', '/v1/internal/access-overrides/pending'], ['POST', '/v1/internal/access-overrides/operation/release'],
  ['POST', '/v1/internal/catalog/products'], ['POST', '/v1/internal/catalog/products/course:retired/withdraw'],
  ['POST', '/v1/internal/catalog/courses/retired/commercial'], ['POST', '/v1/internal/catalog/payment-purpose/retired'],
  ['POST', '/v1/internal/video-uploads'], ['GET', '/v1/internal/video-uploads/retired-session'],
];
const check = (condition, code) => { if (!condition) throw new Error(code); };
try {
  check(typeof input.password === 'string' && input.password.length >= 32
    && typeof input.serviceToken === 'string' && input.serviceToken.length >= 32, 'SMOKE_INPUT');
  for (const [method, path] of retired) {
    const r = await fetch('http://127.0.0.1:3002' + path, { method,
      headers: { authorization: 'Bearer ' + input.serviceToken, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(15000) });
    await r.body?.cancel(); check(r.status === 404, 'SMOKE_RETIRED_404');
  }
  let r = await fetch(base + '/v1/admin/v2/catalogue', { headers });
  await r.body?.cancel(); check(r.status === 401, 'SMOKE_ADMIN_ANONYMOUS');
  r = await fetch(base + '/v1/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: input.password }) });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  await r.body?.cancel(); check(r.status === 200 && cookie, 'SMOKE_ADMIN_LOGIN');
  for (const path of ['/v1/admin/session', '/v1/admin/v2/catalogue']) {
    r = await fetch(base + path, { headers: { ...headers, cookie } });
    await r.body?.cancel(); check(r.status === 200, 'SMOKE_ADMIN_READ');
  }
  for (const path of ['/login', '/courses', '/release.json']) {
    r = await fetch(base + path, { headers }); await r.body?.cancel(); check(r.status === 200, 'SMOKE_ADMIN_STATIC');
  }
  r = await fetch(base + '/partner', { headers }); await r.body?.cancel(); check(r.status === 404, 'SMOKE_PARTNER_CLOSED');
  r = await fetch(base + '/v1/admin/logout', { method: 'POST', headers: { ...headers, cookie }, body: '{}' });
  await r.body?.cancel(); check(r.status === 200, 'SMOKE_ADMIN_LOGOUT');
  r = await fetch(base + '/v1/admin/session', { headers: { ...headers, cookie } });
  await r.body?.cancel(); check(r.status === 401, 'SMOKE_ADMIN_REVOCATION');
  console.log(JSON.stringify({ state: 'INTERNAL_SMOKE_PASS', retiredRoutes404: 10,
    adminAnonymous401: true, adminLoginReadLogout: true, revokedSession401: true, staticPages200: true, partner404: true }));
} catch (error) {
  // Never dump responses, cookies, passwords or arbitrary error messages.
  console.log(JSON.stringify({ state: 'INTERNAL_SMOKE_HOLD', code: error instanceof Error && /^SMOKE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'SMOKE_TRANSPORT' }));
  process.exitCode = 1;
}
