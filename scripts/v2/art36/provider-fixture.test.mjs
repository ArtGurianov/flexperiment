import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createFixtureServer, mintFixtureToken, validateConfig } from './provider-fixture.mjs';
const config = { purpose: 'ART36_ISOLATED_PROVIDER_ONLY', projectId: randomUUID(), videoId: randomUUID(),
  path: '/__art36/' + 'a'.repeat(32) + '/authorize', username: 'art36-' + 'a'.repeat(16),
  password: 'p'.repeat(43), tokenKey: 'k'.repeat(43) };
const auth = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64');

test('shared project, arbitrary route/config and weak credentials are refused', () => {
  for (const delta of [{ projectId: '6964ab60-0ba1-4738-82d2-eada67792e0b' }, { path: '/v1/kinescope/drm/authorize' },
    { purpose: 'production' }, { password: 'short' }, { tokenKey: 'short' }, { extra: 'value' }])
    assert.throws(() => validateConfig({ ...config, ...delta }), /ART36_CONFIG_REFUSED/);
});

test('real HTTP boundary, fault cases, signature/expiry, log secrecy and body cap', async () => {
  const events = [], delays = [];
  const server = createFixtureServer(config, { emit: event => events.push(event), delay: async ms => { delays.push(ms); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const token = (kind, expiresAt = Math.floor(Date.now() / 1000) + 120) => mintFixtureToken(config, { kind, reference: randomUUID(), expiresAt });
  const send = async (data, headers = {}, path = config.path, method = 'POST') => {
    const response = await fetch(origin + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' ? typeof data === 'string' ? data : JSON.stringify(data) : undefined });
    assert.equal(await response.text(), ''); return response;
  };
  const body = value => ({ id: config.videoId, type: 'vod', token: value, ip: 'PRIVATE_VIEWER_IP', user_agent: 'PRIVATE_USER_AGENT' });
  try {
    assert.equal((await send(null, {}, '/healthz', 'GET')).status, 200);
    assert.equal((await send(body(token('allow')), { Authorization: 'Basic PRIVATE_BAD_AUTH' })).status, 401);
    assert.equal((await send(body(token('allow')), {}, '/wrong')).status, 404);
    assert.equal((await send(null, {}, config.path, 'GET')).status, 404);
    assert.equal((await send('{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send('{PRIVATE_BROKEN_JSON')).status, 400);
    assert.equal((await send('a'.repeat(8193))).status, 413);
    assert.equal((await send({ ...body(token('allow')), id: randomUUID() })).status, 403);
    assert.equal((await send({ ...body(token('allow')), type: 'live' })).status, 403);
    assert.equal((await send(body(token('allow', Math.floor(Date.now() / 1000) - 1)))).status, 403);
    assert.equal((await send(body(token('allow') + 'x'))).status, 403);
    assert.equal((await send(body('PRIVATE_ARBITRARY_TOKEN'))).status, 403);
    for (const [kind, status] of [['allow', 200], ['deny', 403], ['unauthorized', 401], ['error', 500], ['timeout', 200]]) {
      const response = await send(body(token(kind))); assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(delays, [7000]);
    await assert.rejects(() => send(body(token('disconnect'))));
    assert.equal(events.length, 6);
    for (const e of events) assert.deepEqual(Object.keys(e).sort(), ['elapsedMs', 'event', 'intendedStatus', 'kind', 'observedAt', 'reference', 'responseAlreadyDestroyed']);
    for (const secret of ['PRIVATE_', config.password, config.tokenKey, config.videoId, auth]) assert.ok(!JSON.stringify(events).includes(secret));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
