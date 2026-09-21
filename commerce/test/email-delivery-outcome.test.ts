import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { openUnmigratedTestDatabase } from "./support/test-database";

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


describe("email delivery outcome", () => {
  describe("database guards", () => {
    const migrated = () => {
      const db = openUnmigratedTestDatabase();
      migrate(db);
      return db;
    };
    const insert = (db: ReturnType<typeof openDatabase>, id: string, status: string, outcome: string | null) =>
      db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, delivery_outcome)
        VALUES (?, 'TEST', 'a@b.invalid', 'h-' || ?, 'tpl', '{}', ?, ?)`)
        .run(id, id, status, outcome);

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
      expect(() => db.exec("UPDATE email_outbox SET suppressed_at = '2026-01-01T00:00:00.000Z', delivery_outcome = NULL WHERE id = 'g6'"))
        .toThrow(/EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT/);
    });


  });

  /**
   * The seam. A schema that is correct today and a writer that forgets the
   * column tomorrow leaves the same untrue assertion in the database, which is
   * exactly the shape of defect this codebase has repeatedly shipped: the rule
   * was real, nothing enforced it where the work happens.
   *
   * The database guards above prove the rule at the boundary; this proves the
   * writers do not arrive there with it already broken.
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
      // Guards vacuity only. A fixed higher floor was calibrated to the
      // pre-seam code and is now actively wrong: converting seams consolidates
      // duplicated writers into shared helpers, so the count legitimately
      // falls, and the guard would fail for a good change.
      expect(terminalFailureWrites.length).toBeGreaterThan(0);
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
        // Counted, not merely found. A function holding two branches would
        // otherwise be satisfied by one branch's provenance while the other
        // claimed KNOWN_FAILED with none - verified
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

  });
});
