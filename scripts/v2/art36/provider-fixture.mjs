/** Isolated ART36 provider fixture. Never import Commerce or authorize live courses. */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHARED_PROJECT = '6964ab60-0ba1-4738-82d2-eada67792e0b';
const CASES = new Set(['allow', 'deny', 'unauthorized', 'error', 'timeout', 'disconnect']);
const MAX_BODY = 8192;
const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function validateConfig(c) {
  const keys = ['purpose', 'projectId', 'videoId', 'path', 'username', 'password', 'tokenKey'];
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== keys.length
      || !keys.every(k => typeof c[k] === 'string')
      || c.purpose !== 'ART36_ISOLATED_PROVIDER_ONLY' || !UUID.test(c.projectId)
      || c.projectId === SHARED_PROJECT || !UUID.test(c.videoId)
      || !/^\/__art36\/[a-f0-9]{32}\/authorize$/.test(c.path)
      || !/^art36-[a-f0-9]{16}$/.test(c.username)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(c.password)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(c.tokenKey)) throw new Error('ART36_CONFIG_REFUSED');
  return Object.freeze({ ...c });
}

export function mintFixtureToken(config, { kind, reference, expiresAt }) {
  if (!CASES.has(kind) || !UUID.test(reference) || !Number.isSafeInteger(expiresAt))
    throw new Error('ART36_TOKEN_INPUT_REFUSED');
  const body = Buffer.from(JSON.stringify({ kind, reference, expiresAt })).toString('base64url');
  const signature = createHmac('sha256', config.tokenKey).update('ART36_FIXTURE_ONLY.' + body).digest('base64url');
  return body + '.' + signature;
}

function verifyFixtureToken(config, value, now) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const [body, signature] = value.split('.');
  const expected = createHmac('sha256', config.tokenKey).update('ART36_FIXTURE_ONLY.' + body).digest('base64url');
  if (!equal(signature, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || Object.keys(data).sort().join(',') !== 'expiresAt,kind,reference'
      || !CASES.has(data.kind) || !UUID.test(data.reference)
      || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now
      || data.expiresAt > now + 300) return null;
  return data;
}

export function createFixtureServer(input, {
  emit = event => process.stdout.write(JSON.stringify(event) + '\n'),
  now = () => Date.now(),
  delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)),
} = {}) {
  const config = validateConfig(input);
  const expectedAuth = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const finish = status => {
      response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      response.end();
    };
    if (request.method === 'GET' && request.url === '/healthz') return finish(200);
    if (request.method !== 'POST' || request.url !== config.path) return finish(404);
    if (!equal(request.headers.authorization ?? '', expectedAuth)) return finish(401);
    if (active >= 8) return finish(429);
    active++;
    const started = now();
    try {
      if ((request.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') return finish(415);
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) return finish(413);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(400); }
      if (!body || body.id !== config.videoId || body.type !== 'vod') return finish(403);
      const token = verifyFixtureToken(config, body.token, Math.floor(now() / 1000));
      if (!token) return finish(403);
      const status = { allow: 200, deny: 403, unauthorized: 401, error: 500, timeout: 200, disconnect: null }[token.kind];
      if (token.kind === 'timeout') await delay(7000);
      emit({ event: 'ART36_FIXTURE_CALLBACK', kind: token.kind, reference: token.reference,
        intendedStatus: status, responseAlreadyDestroyed: response.destroyed, elapsedMs: Math.max(0, now() - started), observedAt: new Date(now()).toISOString() });
      if (token.kind === 'disconnect') request.socket.destroy();
      else if (!response.destroyed) finish(status);
    } catch {
      if (!response.destroyed) finish(400);
    } finally { active--; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(12000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const config = JSON.parse(readFileSync('/run/art36/fixture.json', 'utf8'));
    createFixtureServer(config).listen(8087, '0.0.0.0');
  } catch {
    process.stderr.write('ART36_FIXTURE_START_REFUSED\n');
    process.exitCode = 1;
  }
}
