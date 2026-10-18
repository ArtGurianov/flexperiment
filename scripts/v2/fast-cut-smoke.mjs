// Internal synthetic Control Room smoke. Credentials arrive only on stdin.
import { readFileSync } from 'node:fs';
import http from 'node:http';
const input = JSON.parse(readFileSync(0, 'utf8'));
const base = 'http://admin';
const request = (url, options = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, options, response => {
    response.resume(); response.on('end', () => resolve({ status: response.statusCode,
      headers: { get: key => { const value = response.headers[key.toLowerCase()]; return Array.isArray(value) ? value.join(',') : value; } } }));
  });
  req.setTimeout(15000, () => req.destroy(new Error('SMOKE_TRANSPORT')));
  req.on('error', reject); req.end(options.body);
});
const headers = { host: 'canary-admin.flexperiment.ru', origin: 'https://canary-admin.flexperiment.ru', 'content-type': 'application/json' };
const retired = [
  ['POST', '/v1/internal/course-manifests'], ['POST', '/v1/internal/access-overrides'],
  ['GET', '/v1/internal/access-overrides/pending'], ['POST', '/v1/internal/access-overrides/operation/release'],
  ['POST', '/v1/internal/catalog/products'], ['POST', '/v1/internal/catalog/products/course:retired/withdraw'],
  ['POST', '/v1/internal/catalog/courses/retired/commercial'], ['POST', '/v1/internal/catalog/payment-purpose/retired'],
  ['POST', '/v1/internal/video-uploads'], ['GET', '/v1/internal/video-uploads/retired-session'],
  // ART-31: service-token writes and Control Room read duplicates.
  ['POST', '/v1/internal/sales-activations'], ['POST', '/v1/internal/legal-releases'],
  ['POST', '/v1/internal/merchant-promotions'], ['POST', '/v1/internal/campaigns'],
  ['POST', '/v1/internal/refunds/smoke/execute'], ['GET', '/v1/internal/control-room/customers'],
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
  let r = await request(base + '/v1/admin/v2/catalogue', { headers });
  await r.body?.cancel(); check(r.status === 401, 'SMOKE_ADMIN_ANONYMOUS');
  // With TOTP (ART-31) the password alone opens nothing; the second factor exists only on the
  // owner's device, so an authenticated read is the owner's own check after enrollment.
  r = await request(base + '/v1/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: input.password }) });
  // 401 once a factor is enrolled, 403 CONTROL_ROOM_TOTP_NOT_ENROLLED before: never a session.
  await r.body?.cancel(); check([401, 403].includes(r.status) && !r.headers.get('set-cookie'), 'SMOKE_ADMIN_PASSWORD_ONLY');
  for (const path of ['/login', '/courses', '/release.json']) {
    r = await request(base + path, { headers }); await r.body?.cancel(); check(r.status === 200, 'SMOKE_ADMIN_STATIC');
  }
  r = await request(base + '/partner', { headers }); await r.body?.cancel(); check(r.status === 404, 'SMOKE_PARTNER_CLOSED');
  console.log(JSON.stringify({ state: 'INTERNAL_SMOKE_PASS', retiredRoutes404: retired.length,
    adminAnonymous401: true, passwordOnlyLogin401: true, staticPages200: true, partner404: true }));
} catch (error) {
  // Never dump responses, cookies, passwords or arbitrary error messages.
  console.log(JSON.stringify({ state: 'INTERNAL_SMOKE_HOLD', code: error instanceof Error && /^SMOKE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'SMOKE_TRANSPORT' }));
  process.exitCode = 1;
}
