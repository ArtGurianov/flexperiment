import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { agentReferralsDormantReadinessEvidence, agentReferralsDormantReady } from "../src/agent-referrals-dormant-readiness";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-dormant-readiness-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

describe("agentReferralsDormantReadinessEvidence / agentReferralsDormantReady", () => {
  it("is ready on a freshly migrated database: DORMANT, schema present, zero business facts", () => {
    const db = fresh();
    const evidence = agentReferralsDormantReadinessEvidence(db);
    expect(evidence).toMatchObject({
      ready: true, feature_state: "DORMANT", schema_present: true, schema_missing: [],
      business_facts_all_zero: true, reasons: [],
    });
    expect(agentReferralsDormantReady(db)).toBe(true);
  });

  it("is not ready once activated, and names the feature-state reason (plus the transition event itself, correctly counted as a business fact)", () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "owner-1", reason: "test" });
    const evidence = agentReferralsDormantReadinessEvidence(db);
    expect(evidence.ready).toBe(false);
    expect(evidence.feature_state).toBe("ACTIVE");
    expect(evidence.reasons).toEqual(["FEATURE_STATE_NOT_DORMANT:ACTIVE", "BUSINESS_FACTS_PRESENT"]);
    expect(evidence.business_facts_tables?.agent_referrals_feature_state_events).toBe(1);
    expect(agentReferralsDormantReady(db)).toBe(false);
  });

  it("is not ready when a business fact exists, and names that reason without touching feature_state", () => {
    const db = fresh();
    db.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json) VALUES (?, ?)").run("k", "{}");
    const evidence = agentReferralsDormantReadinessEvidence(db);
    expect(evidence.ready).toBe(false);
    expect(evidence.feature_state).toBe("DORMANT");
    expect(evidence.reasons).toEqual(["BUSINESS_FACTS_PRESENT"]);
    expect(evidence.business_facts_all_zero).toBe(false);
    expect(evidence.business_facts_tables?.agent_referrals_activation_manifest).toBe(1);
  });

  it("round-7 fix: is not ready when the schema is incomplete, and reports this as ordinary evidence - never throws, never counts business facts against a broken schema", () => {
    const db = fresh();
    db.exec("DROP TABLE engagements");
    let evidence: ReturnType<typeof agentReferralsDormantReadinessEvidence> | undefined;
    expect(() => { evidence = agentReferralsDormantReadinessEvidence(db); }).not.toThrow();
    expect(evidence!.ready).toBe(false);
    expect(evidence!.schema_present).toBe(false);
    expect(evidence!.schema_missing).toContain("engagements");
    expect(evidence!.reasons.some((r) => r.startsWith("SCHEMA_INCOMPLETE:"))).toBe(true);
    // Business facts are unproven, not zero, against a broken schema.
    expect(evidence!.business_facts_all_zero).toBeNull();
    expect(evidence!.business_facts_tables).toBeNull();
    expect(agentReferralsDormantReady(db)).toBe(false);
  });

  it("can report multiple simultaneous reasons - not activated feature_state alone masking a business-fact reason", () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "owner-1", reason: "test" });
    db.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json) VALUES (?, ?)").run("k", "{}");
    const evidence = agentReferralsDormantReadinessEvidence(db);
    expect(evidence.ready).toBe(false);
    expect(evidence.reasons).toEqual(["FEATURE_STATE_NOT_DORMANT:ACTIVE", "BUSINESS_FACTS_PRESENT"]);
  });
});
