// Run only in an isolated container built from ART-337's exact source.
// /proof contains COPIES, never a mounted live merchant/fence directory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { readErasureVerificationKeys } from '/app/commerce-v2/src/erasure-runtime.ts';
import { prepareLibraryErasureRead } from '/app/commerce-v2/src/erasure-library-read.ts';
import { applyIsolatedRestoreErasure } from '/app/commerce-v2/src/erasure-restore.ts';
import { migrateV2 } from '/app/commerce-v2/src/db.ts';

const target = '08523bdf38eeddf5e745ce04d05e1f980a7ced93';
const identity = JSON.parse(readFileSync('/app/.identity/identity.json', 'utf8'));
assert.equal(identity.sourceCommit, target);
assert.equal(identity.service, 'commerce-v2');
const keys = readErasureVerificationKeys('/etc/flexperiment-erasure-keys/verification.json', 'canary');
const library = prepareLibraryErasureRead({
  file: '/etc/flexperiment-erasure-read/reader.json',
  scope: 'canary', keys, forbiddenRoots: ['/proof']
});
const count = (db, table) => db.prepare('SELECT COUNT(*) n FROM ' + table).get().n;
const results = [];
try {
  for (const kind of ['synthetic25', 'synthetic26', 'current26']) {
    const db = new Database('/proof/' + kind + '.sqlite', { fileMustExist: true });
    try {
      db.pragma('foreign_keys=ON');
      const beforeMigrations = count(db, 'schema_migrations');
      const beforeUsers = count(db, '"user"');
      const beforeSessions = count(db, '"session"');
      if (kind !== 'synthetic25') migrateV2(db);
      const migrationCount = count(db, 'schema_migrations');
      assert.equal(migrationCount, kind === 'synthetic25' ? 25 : 26);
      if (kind.startsWith('synthetic')) {
        assert.equal(beforeUsers, 1);
        assert.equal(beforeSessions, 1);
      } else {
        assert.equal(beforeUsers, 0);
        assert.equal(beforeSessions, 0);
      }
      const proof = await library.read();
      const applied = applyIsolatedRestoreErasure(db, proof, keys, 'canary');
      assert.equal(applied.sequence, proof.bundle.entries.length);
      assert.equal(count(db, '"user"'), 0);
      assert.equal(count(db, '"session"'), 0);
      assert.equal(count(db, 'customers'), 0);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      results.push({ kind, beforeMigrations, migrationCount, beforeUsers, beforeSessions,
        appliedSequence: applied.sequence, erasedAccounts: applied.erasedAccounts,
        integrity: 'ok', foreignKeys: 'ok' });
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ target, result: 'PASS', proofs: results }));
} finally { library.close(); }
