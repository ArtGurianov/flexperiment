import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  activateAgentReferrals,
  agentReferralsFeatureState,
  agentReferralsFeatureStateAt,
  AgentReferralsFeatureError,
  lastAgentReferralsFeatureStateEvent,
  reactivateAgentReferrals,
  suspendAgentReferrals,
} from "../src/agent-referrals-feature-state";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-feature-state-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

describe("agent-referrals feature state", () => {
  describe("atomicity: the CAS UPDATE and the audit INSERT commit together or not at all", () => {
    it("an INSERT failure after a successful UPDATE rolls back the whole transition", () => {
      const db = fresh();
      // Poisons only the audit INSERT, after the CAS UPDATE has already run
      // inside the same transaction attempt - proves the two are not two
      // independently-committing statements.
      db.exec(`CREATE TRIGGER poison_feature_state_event_insert
        BEFORE INSERT ON agent_referrals_feature_state_events
        BEGIN SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE'); END;`);

      expect(() => activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "poisoned" }))
        .toThrow(/INJECTED_AUDIT_FAILURE/);

      db.exec("DROP TRIGGER poison_feature_state_event_insert");
      expect(agentReferralsFeatureState(db)).toEqual({ state: "DORMANT", owner_id: null, revision: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual({ n: 0 });

      // The connection is left usable afterward, not stuck mid-transaction.
      expect(() => activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "retry" })).not.toThrow();
      expect(agentReferralsFeatureState(db)).toMatchObject({ state: "ACTIVE", revision: 2 });
    });
  });

  it("ships DORMANT, unowned, revision 1, on a fresh DB", () => {
    const db = fresh();
    expect(agentReferralsFeatureState(db)).toEqual({ state: "DORMANT", owner_id: null, revision: 1 });
  });

  describe("valid transitions", () => {
    it("DORMANT -> ACTIVE advances exactly +1 revision and writes exactly one audit event", () => {
      const db = fresh();
      const before = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get();
      const result = activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "foundation test" });
      expect(result).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 2 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual({ n: (before as { n: number }).n + 1 });
      const event = lastAgentReferralsFeatureStateEvent(db) as Record<string, unknown>;
      expect(event).toMatchObject({ from_state: "DORMANT", to_state: "ACTIVE", owner_id: "op-1", reason: "foundation test", revision: 2 });
    });

    it("ACTIVE -> SUSPENDED -> ACTIVE, each a single +1 revision step", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      const suspended = suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "suspend" });
      expect(suspended).toEqual({ state: "SUSPENDED", owner_id: "op-1", revision: 3 });
      const reactivated = reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "op-1", reason: "reactivate" });
      expect(reactivated).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 4 });
    });
  });

  describe("stale expected_revision", () => {
    it("a genuine conflict (different target than current) throws and mutates nothing", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "suspend" });
      const before = agentReferralsFeatureState(db);
      const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get();

      // Stale: current revision is 3 (SUSPENDED), this call still thinks it's 2.
      expect(() => reactivateAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "stale reactivate" }))
        .toThrow(AgentReferralsFeatureError);
      expect(agentReferralsFeatureState(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual(eventsBefore);
    });

    it("throws AGENT_REFERRALS_FEATURE_REVISION_CONFLICT specifically", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      // Different owner AND stale revision, requesting a different target
      // (SUSPENDED) - past the owner-conflict check would also refuse this,
      // so use the same owner to isolate the CAS-only failure path.
      let thrown: unknown;
      try {
        suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "wrong" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AgentReferralsFeatureError);
      expect((thrown as AgentReferralsFeatureError).code).toBe("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT");
    });
  });

  describe("same-owner replay", () => {
    it("replaying the already-held state is a no-op: same revision, no duplicate event", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get();

      const replay = activateAgentReferrals(db, { expected_revision: 1 /* deliberately stale, must not matter */, owner_id: "op-1", reason: "replay" });
      expect(replay).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 2 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual(eventsBefore);
    });
  });

  describe("different-owner conflict", () => {
    it("refuses before any mutation, even for a legal edge", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      const before = agentReferralsFeatureState(db);
      const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get();

      expect(() => suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-2", reason: "hostile suspend" }))
        .toThrow(AgentReferralsFeatureError);
      try {
        suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-2", reason: "hostile suspend" });
      } catch (error) {
        expect((error as AgentReferralsFeatureError).code).toBe("AGENT_REFERRALS_FEATURE_OWNER_CONFLICT");
      }
      expect(agentReferralsFeatureState(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual(eventsBefore);
    });

    it("a different owner CAN claim DORMANT -> ACTIVE, since DORMANT is unowned", () => {
      const db = fresh();
      expect(() => activateAgentReferrals(db, { expected_revision: 1, owner_id: "anyone", reason: "first claim" })).not.toThrow();
    });
  });

  describe("illegal graph edges", () => {
    it("refuses DORMANT -> SUSPENDED directly", () => {
      const db = fresh();
      expect(() => suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "skip" }))
        .toThrow(/AGENT_REFERRALS_FEATURE_ILLEGAL_TRANSITION/);
    });

    it("refuses any transition back to DORMANT (no exported function even offers it, checked structurally)", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-feature-state.ts"), "utf8");
      // Every legal-edge target is a member of a Set([...]) literal in
      // LEGAL_EDGES. "DORMANT" never appears inside one anywhere in the file
      // - the only way it could be a legal transition TARGET.
      const setLiterals = source.match(/new Set\(\[[^\]]*\]\)/g) ?? [];
      expect(setLiterals.length).toBeGreaterThan(0);
      for (const set of setLiterals) expect(set).not.toContain("DORMANT");
      // And no exported function transitions to DORMANT at all.
      expect(source).not.toMatch(/transition\(db, ?"DORMANT"/);
    });
  });

  describe("concurrent writers", () => {
    it("at most one CAS winner: two connections racing to the same expected_revision", () => {
      const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-feature-state-race-")), "commerce.sqlite");
      const a = openDatabase(file); migrate(a); open.push(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      const first = activateAgentReferrals(a, { expected_revision: 1, owner_id: "op-1", reason: "winner" });
      expect(first).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 2 });

      // b still believes revision is 1 (its pre-race read), and requests a
      // DIFFERENT target (SUSPENDED) than what a already applied - a genuine
      // conflict, not an idempotent replay.
      expect(() => suspendAgentReferrals(b, { expected_revision: 1, owner_id: "op-1", reason: "loser" }))
        .toThrow(/AGENT_REFERRALS_FEATURE_REVISION_CONFLICT/);

      expect(agentReferralsFeatureState(a)).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 2 });
      expect(featureStateEventCount(a)).toBe(1);
    });
  });

  describe("SUSPENDED -> ACTIVE does not auto-reactivate anything else", () => {
    /**
     * PR3 has no engagement table to prove this against (PR5's scope, and
     * the plan explicitly forbids building one early just for this proof).
     * The foundation-level property this PR CAN and must prove: the
     * transition function's only durable effect, ever, is on
     * agent_referrals_feature_state and agent_referrals_feature_state_events
     * - nothing else in the schema is touched, so there is structurally
     * nothing for a reactivation to "auto-reactivate" beyond the singleton
     * itself.
     */
    it("touches only its own singleton and its own event table - every other table's row count is unchanged", () => {
      const db = fresh();
      const otherTables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('agent_referrals_feature_state', 'agent_referrals_feature_state_events', 'schema_migrations')").all() as { name: string }[]).map((r) => r.name);
      expect(otherTables.length).toBeGreaterThan(0);
      const before = Object.fromEntries(otherTables.map((name) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));

      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "activate" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "suspend" });
      reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "op-1", reason: "reactivate" });

      const after = Object.fromEntries(otherTables.map((name) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
      expect(after).toEqual(before);
    });

    it("structurally: the transition function's only UPDATE/INSERT statements target the feature-state tables", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-feature-state.ts"), "utf8");
      // Only real SQL, inside `db.prepare(\`...\`)` template literals - not
      // prose in comments, which may say "UPDATE" in passing.
      const sqlStatements = [...source.matchAll(/db\.prepare\(`([^`]*)`\)/g)].map((match) => match[1]);
      const writeTargets = sqlStatements
        .map((sql) => sql.match(/^\s*(?:UPDATE|INSERT INTO)\s+(\w+)/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]);
      expect(writeTargets.length).toBeGreaterThan(0);
      for (const table of writeTargets) {
        expect(table).toMatch(/^agent_referrals_feature_state(_events)?$/);
      }
    });
  });

  describe("integration-hardening #1: agent_referrals_feature_state_events is structurally append-only, forge-proof history", () => {
    it("proves the previously demonstrated bypass is now impossible: a raw UPDATE on a SUSPENDED event no longer flips historical authority to ACTIVE", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "incident" });
      const suspendEvent = lastAgentReferralsFeatureStateEvent(db) as { revision: number; created_at: string };
      expect(agentReferralsFeatureStateAt(db, suspendEvent.created_at)).toBe("SUSPENDED");

      expect(() => db.prepare("UPDATE agent_referrals_feature_state_events SET to_state = 'ACTIVE' WHERE revision = ?").run(suspendEvent.revision))
        .toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE/);
      expect(agentReferralsFeatureStateAt(db, suspendEvent.created_at)).toBe("SUSPENDED");
    });

    it("a raw DELETE of the SUSPENDED event is refused, and historical authority is unchanged", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "incident" });
      const suspendEvent = lastAgentReferralsFeatureStateEvent(db) as { revision: number; created_at: string };

      expect(() => db.prepare("DELETE FROM agent_referrals_feature_state_events WHERE revision = ?").run(suspendEvent.revision))
        .toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE/);
      expect(agentReferralsFeatureStateAt(db, suspendEvent.created_at)).toBe("SUSPENDED");
    });

    it("UNIQUE(revision) refuses a raw duplicate-revision INSERT that is otherwise lineage-valid", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "incident" });
      const suspendEvent = lastAgentReferralsFeatureStateEvent(db) as { revision: number };
      // Same (from_state, to_state) edge as the real event at this revision,
      // and it chains onto the real predecessor's to_state - lineage-valid
      // on its own; only the duplicate revision number is wrong.
      expect(() => db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision) VALUES ('forged', 'ACTIVE', 'SUSPENDED', 'nobody', 'forged', ?)`)
        .run(suspendEvent.revision)).toThrow(/UNIQUE constraint failed/);
    });

    it("a forged INSERT with an out-of-domain from_state/to_state is refused", () => {
      const db = fresh();
      expect(() => db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision) VALUES ('forged', 'BOGUS', 'ALSO_BOGUS', 'nobody', 'forged', 999)`).run())
        .toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT/);
    });

    it("a forged INSERT that is not the genesis event but claims from_state = DORMANT anyway is refused (does not chain onto the actual last event)", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      const first = lastAgentReferralsFeatureStateEvent(db) as { revision: number };
      expect(() => db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision) VALUES ('forged', 'DORMANT', 'ACTIVE', 'nobody', 'forged', ?)`)
        .run(first.revision + 1)).toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT/);
    });

    it("a forged INSERT skipping a revision (gap in the chain) is refused", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      const first = lastAgentReferralsFeatureStateEvent(db) as { revision: number };
      expect(() => db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision) VALUES ('forged', 'ACTIVE', 'SUSPENDED', 'nobody', 'forged', ?)`)
        .run(first.revision + 2)).toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT/);
    });

    it("round-2 P0: a forged event that chains validly onto the real predecessor (correct from_state/to_state/revision lineage) but was never matched by an actual singleton transition is refused - proves the previously demonstrated 'phantom transition' bypass is now impossible", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });   // revision 2, singleton now ACTIVE/2
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "incident" });     // revision 3, singleton now SUSPENDED/3
      const suspendEvent = lastAgentReferralsFeatureStateEvent(db) as { revision: number };
      expect(agentReferralsFeatureState(db)).toEqual({ state: "SUSPENDED", owner_id: "op-1", revision: 3 });

      // A forged revision-4 SUSPENDED->ACTIVE event: legal edge, chains onto
      // the real revision-3 event's to_state (SUSPENDED) - passes every
      // chain-internal check - but the singleton itself was never actually
      // transitioned to revision 4 / ACTIVE.
      let forgeryThrew = false;
      try {
        db.prepare(`INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at) VALUES ('forged', 'SUSPENDED', 'ACTIVE', 'attacker', 'forged', ?, '2026-06-01 00:00:00.000')`)
          .run(suspendEvent.revision + 1);
      } catch (e) {
        forgeryThrew = true;
        expect((e as Error).message).toMatch(/AGENT_REFERRALS_FEATURE_STATE_EVENT_LINEAGE_INCONSISTENT/);
      }
      expect(forgeryThrew).toBe(true);
      expect(agentReferralsFeatureState(db)).toEqual({ state: "SUSPENDED", owner_id: "op-1", revision: 3 });
      expect(agentReferralsFeatureStateAt(db, "2026-06-01 00:00:00.000")).not.toBe("ACTIVE");
    });

    it("legitimate application-driven transitions are entirely unaffected by the new guards", () => {
      const db = fresh();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "go live" });
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "incident" });
      reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "op-1", reason: "resolved" });
      expect(agentReferralsFeatureState(db)).toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 4 });
      expect(featureStateEventCount(db)).toBe(3);
    });
  });
});

function featureStateEventCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n;
}
