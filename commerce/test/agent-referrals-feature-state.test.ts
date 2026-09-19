import { mkdtempSync } from "node:fs";
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

const eventCount = (db: Database.Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n;

describe("agent referrals feature state", () => {
  it("treats the retained pre-P9 DORMANT row as operationally ACTIVE", () => {
    const db = fresh();
    expect(db.prepare("SELECT state FROM agent_referrals_feature_state WHERE singleton = 1").get()).toEqual({ state: "DORMANT" });
    expect(agentReferralsFeatureState(db)).toEqual({ state: "ACTIVE", owner_id: null, revision: 1 });
    expect(agentReferralsFeatureStateAt(db, "2026-01-01T00:00:00.000Z")).toBe("ACTIVE");
  });

  it("keeps the retired activation command a no-op against an operationally active row", () => {
    const db = fresh();
    expect(activateAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "obsolete" }))
      .toEqual({ state: "ACTIVE", owner_id: null, revision: 1 });
    expect(eventCount(db)).toBe(0);
  });

  it("atomically materializes the physical state before the first operational suspension", () => {
    const db = fresh();
    const suspended = suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "incident" });

    expect(suspended).toEqual({ state: "SUSPENDED", owner_id: "op-1", revision: 3 });
    expect(db.prepare("SELECT state, revision FROM agent_referrals_feature_state WHERE singleton = 1").get())
      .toEqual({ state: "SUSPENDED", revision: 3 });
    expect(db.prepare("SELECT from_state, to_state, reason, revision FROM agent_referrals_feature_state_events ORDER BY revision").all())
      .toEqual([
        { from_state: "DORMANT", to_state: "ACTIVE", reason: "P5_PREBASELINE_ACTIVE", revision: 2 },
        { from_state: "ACTIVE", to_state: "SUSPENDED", reason: "incident", revision: 3 },
      ]);
  });

  it("preserves the operational ACTIVE to SUSPENDED to ACTIVE lifecycle and historical suspension", () => {
    const db = fresh();
    suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "incident" });
    const suspendedAt = (lastAgentReferralsFeatureStateEvent(db) as { created_at: string }).created_at;
    expect(agentReferralsFeatureStateAt(db, suspendedAt)).toBe("SUSPENDED");

    expect(reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "op-1", reason: "resolved" }))
      .toEqual({ state: "ACTIVE", owner_id: "op-1", revision: 4 });
  });

  it("rolls back physical materialization when its audit insert fails", () => {
    const db = fresh();
    db.exec(`CREATE TRIGGER poison_feature_state_event_insert
      BEFORE INSERT ON agent_referrals_feature_state_events
      BEGIN SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE'); END;`);

    expect(() => suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "incident" }))
      .toThrow(/INJECTED_AUDIT_FAILURE/);
    expect(db.prepare("SELECT state, revision FROM agent_referrals_feature_state WHERE singleton = 1").get())
      .toEqual({ state: "DORMANT", revision: 1 });
    expect(eventCount(db)).toBe(0);
  });

  it("refuses stale revisions and a conflicting owner without mutation", () => {
    const db = fresh();
    suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "incident" });
    const before = agentReferralsFeatureState(db);
    const eventsBefore = eventCount(db);

    expect(() => reactivateAgentReferrals(db, { expected_revision: 2, owner_id: "op-1", reason: "stale" }))
      .toThrow(AgentReferralsFeatureError);
    expect(() => reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "op-2", reason: "hostile" }))
      .toThrow(/AGENT_REFERRALS_FEATURE_OWNER_CONFLICT/);
    expect(agentReferralsFeatureState(db)).toEqual(before);
    expect(eventCount(db)).toBe(eventsBefore);
  });

  it("keeps feature-state history append-only", () => {
    const db = fresh();
    suspendAgentReferrals(db, { expected_revision: 1, owner_id: "op-1", reason: "incident" });
    const event = lastAgentReferralsFeatureStateEvent(db) as { revision: number; created_at: string };

    expect(() => db.prepare("UPDATE agent_referrals_feature_state_events SET to_state = 'ACTIVE' WHERE revision = ?").run(event.revision))
      .toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM agent_referrals_feature_state_events WHERE revision = ?").run(event.revision))
      .toThrow(/AGENT_REFERRALS_FEATURE_STATE_EVENT_IMMUTABLE/);
    expect(agentReferralsFeatureStateAt(db, event.created_at)).toBe("SUSPENDED");
  });
});
