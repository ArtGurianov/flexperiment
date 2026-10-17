// Run only on copies of the merchant SQLite and CLOSED fence in an isolated
// exact-target image. This is a proof, never an owner operation on live data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { migrateV2 } from '/app/commerce-v2/src/db.ts';
import { prepareErasureRuntime } from '/app/commerce-v2/src/erasure-runtime.ts';

const target = '08523bdf38eeddf5e745ce04d05e1f980a7ced93';
const identity = JSON.parse(readFileSync('/app/.identity/identity.json', 'utf8'));
assert.equal(identity.sourceCommit, target);
const environment = {
  DEPLOY_ENV: 'staging', ERASURE_FENCING_ENABLED: 'true', ERASURE_SCOPE: 'canary',
  ERASURE_FENCE_DIRECTORY: '/proof/fence',
  ERASURE_VERIFICATION_KEYS_FILE: '/etc/flexperiment-erasure-keys/verification.json',
  ERASURE_LIBRARY_CONFIG_FILE: '/etc/flexperiment-erasure-read/reader.json'
};
const db = new Database('/proof/merchant/current26.sqlite', { fileMustExist: true });
let fence;
try {
  db.pragma('foreign_keys=ON');
  const before = db.prepare('SELECT count(*) n FROM schema_migrations').get().n;
  assert.equal(before, 25);
  migrateV2(db);
  const after = db.prepare('SELECT count(*) n FROM schema_migrations').get().n;
  assert.equal(after, 26);
  fence = await prepareErasureRuntime({ db, environment, forbiddenRoots: ['/proof/merchant'] });
  assert(fence);
  assert.equal(await fence.ready(), true);
  const status = fence.status();
  assert.equal(status.state, 'OPEN');
  assert.equal(status.leases, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM "user"').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM "session"').get().n, 0);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ target, result: 'BOOT_PASS', beforeMigrations: before,
    afterMigrations: after, erasure: 'qualified', fence: status.state,
    leases: status.leases, integrity: 'ok', foreignKeys: 'ok' }));
} finally { fence?.close(); db.close(); }
