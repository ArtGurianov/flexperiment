import Database from "better-sqlite3";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import { applyIsolatedRestoreErasure, assertReviewedRestoreSchema } from "../src/erasure-restore";
import { cleanupOfflinePersonalData } from "../src/pd-retention";
import { confirmLabInterest, LAB_INTEREST_CONSENT, labInterestConsentSha256, requestLabInterest } from "../src/lab-interest";

const now = new Date("2026-11-22T10:00:00.000Z");
let root: string; let db: Database.Database; let ledger: ErasureLedgerStore; let keys: ErasureKeys;
let signer: { keyId: string; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] };
const consent = { version: LAB_INTEREST_CONSENT.version, textSha256: labInterestConsentSha256 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flex-lab-interest-erasure-"));
  mkdirSync(join(root, "merchant"), { mode: 0o700 }); mkdirSync(join(root, "ledger"), { mode: 0o700 });
  db = new Database(join(root, "merchant", "commerce.sqlite")); db.pragma("foreign_keys=ON"); db.pragma("journal_mode=WAL"); migrateV2(db);
  const signing = generateKeyPairSync("ed25519"); signer = { keyId: "signing-1", privateKey: signing.privateKey };
  keys = { signing: { "signing-1": signing.publicKey }, subject: { "subject-1": randomBytes(32) } };
  ledger = new ErasureLedgerStore({ directory: join(root, "ledger"), scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")] });
  for (const email of ["erased@example.test", "kept@example.test"]) {
    const prepared = requestLabInterest(db, { email, consent }, { origin: "https://lab.example", secret: "synthetic" }, now.toISOString())!;
    confirmLabInterest(db, new URL(prepared.message.confirmUrl).hash.split("=")[1], now.toISOString());
  }
  db.prepare("INSERT INTO lab_interest_notices(signup_id,notice_key,state,attempted_at,sent_at) SELECT id,'opened','SENT',?,? FROM lab_interest_signups")
    .run(now.toISOString(), now.toISOString());
});
afterEach(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });

describe("FLEX-8 interest store under isolated restore and retention", () => {
  it("admits the reviewed schema in both restore and retention", () => {
    expect(() => assertReviewedRestoreSchema(db)).not.toThrow();
    const policy = { version: 1 as const, referenceSha256: "a".repeat(64), expiredCredentialsGraceSeconds: 600, authOutboxMaxAgeSeconds: 600,
      playbackTelemetryMaxAgeSeconds: 600, unboundIntentsMaxAgeSeconds: 600, backupArchiveMaxAgeSeconds: 600 };
    expect(() => cleanupOfflinePersonalData(db, { mode: "STOPPED_OFFLINE", policy, holds: [] }, now)).not.toThrow();
    // Generic retention does not purge the interest store: its policy lives in purgeLabInterest.
    expect((db.prepare("SELECT COUNT(*) n FROM lab_interest_signups").get() as { n: number }).n).toBe(2);
  });

  it("does not resurrect an erased interest-only subject from an older backup and keeps it suppressed", async () => {
    const archive = join(root, "before-erasure.sqlite"); await db.backup(archive);
    // An interest-only subject has no customer or user; the ledger subject carries synthetic non-matching ids.
    ledger.append({ requestId: randomUUID(), kind: "ERASURE",
      subject: erasureSubject(keys, "subject-1", "canary", { email: "erased@example.test", customerId: "no-customer", userId: "no-user" }) }, now);
    const proof = await VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
      readCurrentCheckpoint: async (nonce) => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now });
    const restored = new Database(archive); restored.pragma("foreign_keys=ON");
    try {
      expect(applyIsolatedRestoreErasure(restored, proof, keys, "canary", now)).toMatchObject({ erasedAccounts: 0, suppressedEmails: 1 });
      expect(restored.prepare("SELECT email_normalized FROM lab_interest_signups").all()).toEqual([{ email_normalized: "kept@example.test" }]);
      expect(restored.prepare("SELECT COUNT(*) n FROM lab_interest_notices").get()).toEqual({ n: 1 });
      expect(restored.prepare("SELECT email_normalized,reason,removed_at FROM email_suppressions").all())
        .toEqual([{ email_normalized: "erased@example.test", reason: "INDEPENDENT_ERASURE_LEDGER", removed_at: null }]);
      // A new signup of the erased address after restore is a silent no-op.
      expect(requestLabInterest(restored, { email: "erased@example.test", consent }, { origin: "https://lab.example", secret: "synthetic" }, now.toISOString())).toBeNull();
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally { restored.close(); }
  });
});
