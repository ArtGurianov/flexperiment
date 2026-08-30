import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db";

const migrationsDirectory = join(process.cwd(), "commerce", "migrations");
const applyThrough = (db: ReturnType<typeof openDatabase>, last: string) => {
  for (const migration of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql") && name <= last).sort()) {
    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, migration), "utf8")))();
  }
};

/**
 * `status` answers "what may the worker still do with this row".
 * `delivery_outcome` answers "did this reach anyone".
 *
 * They were the same column, and that made `status = 'FAILED'` assert something
 * it could not know: the SEND_UNKNOWN attempt budget running out was recorded as
 * a delivery failure, when nothing about delivery had been established. A resend
 * built on that would send a second copy of a delivered message and log it as
 * recovery.
 *
 * The invariant that matters, and the reason this file exists before any resend
 * code does:
 *
 *   resend eligibility  is NOT  status === 'FAILED'
 *   resend eligibility  is      delivery_outcome === 'KNOWN_FAILED'
 */

const MIGRATION = "0039_email_delivery_outcome.sql";
const PRIOR = "0038_occurrence_availability_notifications.sql";

const outboxRow = (id: string, status: string, lastError: string | null, code: string | null) => ({
  id, status, last_error: lastError, provider_error_code: code,
});

const seed = (db: ReturnType<typeof openDatabase>, rows: ReturnType<typeof outboxRow>[]) => {
  for (const row of rows) {
    db.prepare(`INSERT INTO email_outbox
      (id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status,
       provider_idempotence_key, attempts, last_error, provider_error_code)
      VALUES (?, 'TEST', 'a@b.invalid', 'hash-' || ?, 'tpl', '{}', ?, 'key-' || ?, 1, ?, ?)`)
      .run(row.id, row.id, row.status, row.id, row.last_error, row.provider_error_code);
  }
};

const outcomeOf = (db: ReturnType<typeof openDatabase>, id: string) =>
  (db.prepare("SELECT delivery_outcome FROM email_outbox WHERE id = ?").get(id) as { delivery_outcome: string | null }).delivery_outcome;

describe("email delivery outcome", () => {
  describe("backfill", () => {
    const migrated = (rows: ReturnType<typeof outboxRow>[]) => {
      const db = openDatabase(":memory:");
      applyThrough(db, PRIOR);
      seed(db, rows);
      db.exec(readFileSync(`commerce/migrations/${MIGRATION}`, "utf8"));
      return db;
    };

    it("classifies a received provider rejection as known failed", () => {
      // Production carries these with codes 204, 1588 and 903.
      const db = migrated([outboxRow("r1", "FAILED", "UNISENDER_HTTP_REJECTED", "204")]);
      expect(outcomeOf(db, "r1")).toBe("KNOWN_FAILED");
    });

    it("classifies the legacy deterministic rejection as known failed", () => {
      const db = migrated([outboxRow("r2", "FAILED", "UNISENDER_HTTP_REJECTED_LEGACY", "HTTP_403_LEGACY")]);
      expect(outcomeOf(db, "r2")).toBe("KNOWN_FAILED");
    });

    it("classifies an exhausted reconciliation budget as unresolved, not failed", () => {
      // The whole point. Nothing was established; we stopped asking.
      const db = migrated([outboxRow("r3", "FAILED", "UNISENDER_SEND_UNKNOWN_ATTEMPT_LIMIT_REACHED", "SEND_UNKNOWN_ATTEMPT_LIMIT")]);
      expect(outcomeOf(db, "r3")).toBe("UNRESOLVED");
    });

    it.each([
      ["an error this codebase never wrote", "SOME_FUTURE_ERROR", "X"],
      ["no error recorded at all", null, null],
      ["a provider code with no local error", null, "550"],
    ])("fails closed to unresolved for %s", (_label, lastError, code) => {
      // Guessing KNOWN_FAILED costs a duplicate email to a real person.
      // Guessing UNRESOLVED costs an un-resendable row until someone checks.
      const db = migrated([outboxRow("r4", "FAILED", lastError, code)]);
      expect(outcomeOf(db, "r4")).toBe("UNRESOLVED");
    });

    it("leaves non-terminal and delivered rows unclassified", () => {
      const db = migrated([
        outboxRow("p1", "PENDING", null, null),
        outboxRow("s1", "SENDING", null, null),
        outboxRow("u1", "SEND_UNKNOWN", "UNISENDER_TRANSPORT_AMBIGUOUS", null),
        outboxRow("d1", "DELIVERED", null, null),
        outboxRow("b1", "BOUNCED", null, null),
      ]);
      // A row still in play has no delivery truth yet, and DELIVERED/BOUNCED
      // already state theirs unambiguously - duplicating that here would create
      // a second authority that can drift.
      for (const id of ["p1", "s1", "u1", "d1", "b1"]) expect(outcomeOf(db, id)).toBeNull();
    });

    it("refuses a value outside the domain", () => {
      const db = migrated([outboxRow("r5", "FAILED", "UNISENDER_HTTP_REJECTED", "204")]);
      expect(() => db.exec("UPDATE email_outbox SET delivery_outcome = 'PROBABLY_FINE' WHERE id = 'r5'")).toThrow();
    });

    it("is idempotent when applied to already-classified rows", () => {
      const db = migrated([outboxRow("r6", "FAILED", "UNISENDER_SEND_UNKNOWN_ATTEMPT_LIMIT_REACHED", "SEND_UNKNOWN_ATTEMPT_LIMIT")]);
      // Replay only the classification statements; the column and index already
      // exist. A re-run must not promote UNRESOLVED to KNOWN_FAILED.
      const updates = readFileSync(`commerce/migrations/${MIGRATION}`, "utf8")
        .split(";")
        .filter((statement) => /^\s*UPDATE\b/.test(statement.replace(/^\s*--.*$/gm, "").trim()))
        .filter((statement) => statement.includes("SET delivery_outcome"))
        .map((statement) => statement.replace(/^\s*--.*$/gm, "").trim());
      expect(updates).toHaveLength(2);
      for (const statement of updates) db.exec(`${statement};`);
      expect(outcomeOf(db, "r6")).toBe("UNRESOLVED");
    });
  });

  /**
   * Structural enforcement. The backfill being right today and a writer
   * forgetting the column tomorrow leaves the same untrue assertion in the
   * database, so the rule is stated where the write happens.
   *
   * Deliberately structural only: the trigger says every FAILED row carries an
   * explicit classification and no other row does. It does NOT encode which
   * classification is correct - copying the last_error grammar into SQL would
   * rebuild the two-authorities problem this migration removes.
   */
  describe("database guards", () => {
    const migrated = () => {
      const db = openDatabase(":memory:");
      applyThrough(db, MIGRATION);
      return db;
    };
    const insert = (db: ReturnType<typeof openDatabase>, id: string, status: string, outcome: string | null) =>
      db.prepare(`INSERT INTO email_outbox
        (id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status,
         provider_idempotence_key, attempts, delivery_outcome)
        VALUES (?, 'TEST', 'a@b.invalid', 'h-' || ?, 'tpl', '{}', ?, 'k-' || ?, 1, ?)`)
        .run(id, id, status, id, outcome);

    it("rejects a FAILED row with no delivery classification", () => {
      const db = migrated();
      expect(() => insert(db, "g1", "FAILED", null)).toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });

    it("rejects a classification on a row that has not failed", () => {
      const db = migrated();
      expect(() => insert(db, "g2", "PENDING", "KNOWN_FAILED")).toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });

    it.each([["KNOWN_FAILED"], ["UNRESOLVED"]])("accepts a FAILED row classified %s", (outcome) => {
      const db = migrated();
      expect(() => insert(db, `g3${outcome}`, "FAILED", outcome)).not.toThrow();
    });

    it("rejects an update into FAILED that forgets the classification", () => {
      // The path a future writer would take. This is the case the source-level
      // seam test catches at review time and the trigger catches at runtime.
      const db = migrated();
      insert(db, "g4", "PENDING", null);
      expect(() => db.exec("UPDATE email_outbox SET status = 'FAILED' WHERE id = 'g4'"))
        .toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });

    it("rejects clearing the classification while the row stays failed", () => {
      const db = migrated();
      insert(db, "g5", "FAILED", "UNRESOLVED");
      expect(() => db.exec("UPDATE email_outbox SET delivery_outcome = NULL WHERE id = 'g5'"))
        .toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });

    it("guards updates that do not name the columns at all", () => {
      // BEFORE UPDATE ON, not UPDATE OF: SQLite silently ignores a misspelled
      // column in an UPDATE OF list, giving a guard that looks installed and
      // enforces nothing.
      const db = migrated();
      insert(db, "g6", "FAILED", "UNRESOLVED");
      expect(() => db.exec("UPDATE email_outbox SET attempts = attempts + 1, delivery_outcome = NULL WHERE id = 'g6'"))
        .toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });

    it("aborts the migration when an existing row cannot be classified", () => {
      // The no-op UPDATE at the end of the migration validates history through
      // the guard itself. Proven by seeding a row the backfill cannot reach.
      const db = openDatabase(":memory:");
      applyThrough(db, PRIOR);
      db.prepare(`INSERT INTO email_outbox
        (id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status,
         provider_idempotence_key, attempts, last_error)
        VALUES ('bad', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'FAILED', 'k', 1, 'X')`).run();
      const sql = readFileSync(`commerce/migrations/${MIGRATION}`, "utf8")
        .replace(/UPDATE email_outbox\s+SET delivery_outcome = 'UNRESOLVED'[\s\S]*?;/, "");
      expect(() => db.exec(sql)).toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });
  });

  /**
   * The seam. A backfill that is correct today and a writer that forgets the
   * column tomorrow leaves the same untrue assertion in the database, which is
   * exactly the shape of defect this codebase has repeatedly shipped: the rule
   * was real, nothing enforced it where the work happens.
   *
   * SQLite cannot express "delivery_outcome NOT NULL when status = 'FAILED'" as
   * a constraint on an existing table without the nine-table rebuild this
   * migration exists to avoid, so the guarantee is asserted against the source.
   */
  describe("writer paths", () => {
    // Follows the writers wherever they live: seam conversion moved some into
    // outbox-attempt-store.ts, and a scan pinned to one file would have quietly
    // stopped covering them.
    const source = ["commerce/src/domain.ts", "commerce/src/outbox-attempt-store.ts"]
      .map((file) => readFileSync(file, "utf8")).join("\n");
    const terminalFailureWrites = source
      .split(/(?=SET status = 'FAILED')/)
      .filter((chunk) => chunk.startsWith("SET status = 'FAILED'"));

    it("finds the terminal-failure writers", () => {
      expect(terminalFailureWrites.length).toBeGreaterThanOrEqual(5);
    });

    it.each(terminalFailureWrites.map((chunk, index) => [index, chunk] as const))(
      "writer %i sets a delivery outcome in the same statement",
      (_index, chunk) => {
        const statement = chunk.slice(0, chunk.indexOf("`)") + 2);
        expect(
          statement,
          `a path into FAILED leaves delivery_outcome unset:\n${statement.slice(0, 240)}`,
        ).toMatch(/delivery_outcome = '(KNOWN_FAILED|UNRESOLVED)'/);
      },
    );

    it("only claims KNOWN_FAILED where a provider response was actually received", () => {
      // Scoped to the ENCLOSING function rather than a forward window.
      //
      // Under ATTEMPT the message write carries delivery_outcome while the
      // received rejection is recorded as the attempt's failure_code, in the
      // same transaction - and their order is a correctness decision: the
      // attempt CAS must run first, so the provenance now sits BEHIND the
      // delivery_outcome write. A forward-scanning window missed it and failed
      // for a reason unrelated to the rule.
      // Writers only. `delivery_outcome = 'KNOWN_FAILED'` also appears as a
      // read predicate in several queries, and those carry no provenance
      // because they assert nothing.
      const boundary = /\n(?=export const |  private |  async |  [a-zA-Z]+\()/;
      const regions = source.split(boundary);
      const claiming = regions.filter((region) => /SET[\s\S]{0,200}delivery_outcome = 'KNOWN_FAILED'/.test(region));
      expect(claiming.length, "no KNOWN_FAILED writer found").toBeGreaterThan(0);
      for (const region of claiming) {
        // Counted, not merely found. A function holding both a LEGACY and an
        // ATTEMPT branch would otherwise be satisfied by one branch's
        // provenance while the other claimed KNOWN_FAILED with none - verified
        // by removing the ATTEMPT marker and watching a find-based check pass.
        const claims = region.match(/delivery_outcome = 'KNOWN_FAILED'/g)?.length ?? 0;
        const evidence = region.match(/(last_error|failure_code) = 'UNISENDER_HTTP_REJECTED(_LEGACY)?'/g)?.length ?? 0;
        expect(
          evidence,
          `${claims} KNOWN_FAILED claim(s) with only ${evidence} received-rejection provenance marker(s)`,
        ).toBeGreaterThanOrEqual(claims);
      }
    });

    it("classifies the path that binds the status as a parameter", () => {
      // This one is invisible to the scan above: reconciliation writes
      // `SET status = ?`, so the literal never appears. It was missed until the
      // database trigger rejected it, which is the whole argument for enforcing
      // the fact at the write rather than at review time.
      const parameterised = source
        .split(/(?=UPDATE email_outbox SET status = \?)/)
        .filter((chunk) => chunk.startsWith("UPDATE email_outbox SET status = ?"));
      expect(parameterised).not.toHaveLength(0);
      for (const chunk of parameterised) {
        const statement = chunk.slice(0, chunk.indexOf("`)") + 2);
        expect(statement, "a parameter-bound status write leaves delivery_outcome unset")
          .toMatch(/delivery_outcome = CASE WHEN \? = 'FAILED' THEN 'KNOWN_FAILED' END/);
      }
    });

    it("never lets an exhausted retry budget claim a known failure", () => {
      // Time and attempt counts are scheduling policy. They are not evidence.
      for (const chunk of terminalFailureWrites) {
        const statement = chunk.slice(0, chunk.indexOf("`)") + 2);
        if (!statement.includes("ATTEMPT_LIMIT")) continue;
        expect(statement).toContain("delivery_outcome = 'UNRESOLVED'");
      }
    });
  });

  /**
   * Consumers that previously read FAILED as settled truth. Marking an
   * UNRESOLVED row's dump target CONSUMED would discard the one channel that
   * could still establish what happened - which would manufacture exactly the
   * absence of evidence the split exists to preserve against.
   */
  describe("consumers", () => {
    const source = ["commerce/src/domain.ts", "commerce/src/outbox-attempt-store.ts"]
      .map((file) => readFileSync(file, "utf8")).join("\n");

    it("no longer treats every FAILED row as a settled outcome", () => {
      expect(source).not.toContain("status IN ('DELIVERED', 'BOUNCED', 'FAILED')");
    });

    it("requires a known failure before renewing a city-interest request", () => {
      expect(source).toContain("old_outbox.status = 'FAILED' AND old_outbox.delivery_outcome = 'KNOWN_FAILED'");
    });
  });
});
