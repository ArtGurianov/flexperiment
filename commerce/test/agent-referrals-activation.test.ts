import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS,
  AgentReferralsActivationError,
  agentReferralsActivationEvidence,
  agentReferralsFoundationSchemaEvidence,
  assertAgentReferralsFoundationSchemaPresent,
  recordAgentReferralsActivationEvidence,
} from "../src/agent-referrals-activation";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-activation-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

describe("agent-referrals activation-manifest / schema-evidence machinery", () => {
  it("passes on an untouched migrated DB", () => {
    const db = fresh();
    expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    expect(agentReferralsFoundationSchemaEvidence(db)).toEqual({ present: true, missing: [] });
  });

  it("has no capacity field participating in the required-object list", () => {
    expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.some((name) => /pilot|capacity|cap_/i.test(name))).toBe(false);
  });

  describe("removing one required schema object", () => {
    it.each(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS)("refuses and identifies %s when it is dropped", (objectName) => {
      const db = fresh();
      const kind = (db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(objectName) as { type: string }).type;
      db.exec(`DROP ${kind === "trigger" ? "TRIGGER" : kind === "index" ? "INDEX" : "TABLE"} ${objectName}`);

      let thrown: unknown;
      try { assertAgentReferralsFoundationSchemaPresent(db); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(AgentReferralsActivationError);
      expect((thrown as AgentReferralsActivationError).code).toBe("AGENT_REFERRALS_ACTIVATION_SCHEMA_INCOMPLETE");
      expect((thrown as AgentReferralsActivationError).message).toContain(objectName);

      const evidence = agentReferralsFoundationSchemaEvidence(db);
      expect(evidence.present).toBe(false);
      expect(evidence.missing).toContain(objectName);
    });
  });

  describe("rename/drop a required enforcement object while its proxy table remains", () => {
    it("dropping the legal-profile immutability guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER agent_referrals_legal_profile_revisions_immutable_guard");
      // The proxy table is untouched and present.
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_referrals_legal_profile_revisions'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/agent_referrals_legal_profile_revisions_immutable_guard/);
    });

    it("dropping the channel-policy uniqueness index still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP INDEX ad_channel_policy_channel_revision_unique");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ad_channel_policy'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/ad_channel_policy_channel_revision_unique/);
    });

    it("dropping the framework-agreement immutability guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER framework_agreement_revisions_immutable_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'framework_agreement_revisions'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/framework_agreement_revisions_immutable_guard/);
    });
  });

  it("refuses when 0043 itself was never applied", () => {
    const db = fresh();
    db.prepare("DELETE FROM schema_migrations WHERE version = '0043_agent_referrals_foundation.sql'").run();
    expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
    expect(agentReferralsFoundationSchemaEvidence(db)).toEqual({ present: false, missing: ["0043_agent_referrals_foundation.sql"] });
  });

  describe("manifest evidence store (read-only in PR3)", () => {
    it("returns undefined for an unrecorded key", () => {
      const db = fresh();
      expect(agentReferralsActivationEvidence(db, "payout_profile_encryption_key_id")).toBeUndefined();
    });

    it("round-trips a recorded value, and upserts on a second write", () => {
      const db = fresh();
      recordAgentReferralsActivationEvidence(db, "example_key", { some: "evidence" });
      expect(agentReferralsActivationEvidence(db, "example_key")).toEqual({ some: "evidence" });
      recordAgentReferralsActivationEvidence(db, "example_key", { some: "updated-evidence" });
      expect(agentReferralsActivationEvidence(db, "example_key")).toEqual({ some: "updated-evidence" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get()).toEqual({ n: 1 });
    });

    it("PR3 records no evidence of its own", () => {
      const db = fresh();
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get()).toEqual({ n: 0 });
    });
  });
});
