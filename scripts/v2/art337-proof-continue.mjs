// Execute only in the digest-qualified target image, on COPIES. This does not
// reset/migrate the installed SQLite or write to the owner's live fence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { readErasureVerificationKeys, prepareErasureRuntime } from '/app/commerce-v2/src/erasure-runtime.ts';
import { prepareLibraryErasureRead } from '/app/commerce-v2/src/erasure-library-read.ts';
import { applyIsolatedRestoreErasure } from '/app/commerce-v2/src/erasure-restore.ts';

const target = '08523bdf38eeddf5e745ce04d05e1f980a7ced93';
const schemaFingerprint = 'c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39';
const hash = data => createHash('sha256').update(data).digest('hex');
const identity = JSON.parse(readFileSync('/app/.identity/identity.json', 'utf8'));
assert.deepEqual(identity, { schema: 'flexperiment.build-identity/1', service: 'commerce-v2', sourceCommit: target });
const artifact = JSON.parse(readFileSync('/proof/artifact.json', 'utf8'));
// Use the controller's canonical serialization, including nested keys/newline.
const canonicalRecursive = value => Array.isArray(value) ? `[${value.map(canonicalRecursive).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRecursive(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const artifactSha256 = hash(canonicalRecursive(artifact) + '\n');
const inputCommerceSha256 = hash(readFileSync('/proof/current26.sqlite'));
assert.equal(hash(readFileSync('/proof/merchant/current26.sqlite')), inputCommerceSha256);
assert.equal(hash(readFileSync('/proof/merchant/boot26.sqlite')), inputCommerceSha256);
const proofScriptSha256 = hash(readFileSync(new URL(import.meta.url)));
const mirrorSha256 = hash(readFileSync('/proof/mirror/bundle.json'));
const keys = readErasureVerificationKeys('/etc/flexperiment-erasure-keys/verification.json', 'canary');
const library = prepareLibraryErasureRead({ file: '/etc/flexperiment-erasure-read/reader.json', scope: 'canary', keys,
  forbiddenRoots: ['/proof/merchant'] });
const fingerprint = db => hash(JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
const migrations = db => db.prepare('SELECT count(*) n FROM schema_migrations').get().n;
let ledgerSequence;
try {
  const outcomes = [];
  for (const kind of ['synthetic26', 'current26']) {
    const db = new Database('/proof/merchant/' + kind + '.sqlite', { fileMustExist: true });
    try {
      db.pragma('foreign_keys=ON');
      assert.equal(migrations(db), 26);
      assert.equal(fingerprint(db), schemaFingerprint);
      const before = db.prepare('SELECT count(*) n FROM "user"').get().n;
      assert.equal(before, kind === 'synthetic26' ? 1 : 0);
      const proof = await library.read();
      ledgerSequence = proof.bundle.entries.length;
      const result = applyIsolatedRestoreErasure(db, proof, keys, 'canary');
      assert.equal(result.erasedAccounts, before);
      assert.equal(result.sequence, ledgerSequence);
      assert.equal(db.prepare('SELECT count(*) n FROM "user"').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM "session"').get().n, 0);
      assert.equal(migrations(db), 26);
      assert.equal(fingerprint(db), schemaFingerprint);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      outcomes.push(result.erasedAccounts);
    } finally { db.close(); }
  }
  const environment = { DEPLOY_ENV: 'staging', ERASURE_FENCING_ENABLED: 'true', ERASURE_SCOPE: 'canary',
    ERASURE_FENCE_DIRECTORY: '/proof/fence', ERASURE_VERIFICATION_KEYS_FILE: '/etc/flexperiment-erasure-keys/verification.json',
    ERASURE_LIBRARY_CONFIG_FILE: '/etc/flexperiment-erasure-read/reader.json' };
  const db = new Database('/proof/merchant/boot26.sqlite', { fileMustExist: true });
  let fence;
  try {
    db.pragma('foreign_keys=ON');
    assert.equal(migrations(db), 26);
    assert.equal(fingerprint(db), schemaFingerprint);
    const copiedFence = new Database('/proof/fence/erasure-fence.sqlite', { fileMustExist: true, readonly: true });
    try {
      const state = copiedFence.prepare('SELECT scope,state,owner FROM fence_state WHERE id=1').get();
      assert.deepEqual(state, { scope: 'canary', state: 'CLOSED', owner: null });
      assert.equal(copiedFence.prepare('SELECT count(*) n FROM fence_leases').get().n, 0);
    } finally { copiedFence.close(); }
    assert.equal(db.prepare('SELECT count(*) n FROM "user"').get().n, 0);
    fence = await prepareErasureRuntime({ db, environment, forbiddenRoots: ['/proof/merchant'] });
    assert.equal(await fence.ready(), true);
    assert.equal(fence.status().state, 'OPEN');
    assert.equal(fence.status().leases, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM "user"').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM "session"').get().n, 0);
    assert.equal(migrations(db), 26);
    assert.equal(fingerprint(db), schemaFingerprint);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { fence?.close(); db.close(); }
  const common = { recordedAt: new Date().toISOString(), sourceCommit: target, artifactSha256, inputCommerceSha256,
    schemaFingerprint, proofScriptSha256, beforeMigrations: 26, afterMigrations: 26, integrity: 'ok', foreignKeys: 'ok', ledgerSequence, mirrorSha256 };
  console.log(JSON.stringify({ restore: { ...common, result: 'PASS', syntheticErasedAccounts: outcomes[0], currentUsers: 0 },
    boot: { ...common, result: 'BOOT_PASS', fence: 'OPEN', leases: 0 } }));
} finally { library.close(); }
