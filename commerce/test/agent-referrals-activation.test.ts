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

    it("dropping the legal-profile DELETE guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER agent_referrals_legal_profile_revisions_delete_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_referrals_legal_profile_revisions'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/agent_referrals_legal_profile_revisions_delete_guard/);
    });

    it("dropping the framework-agreement DELETE guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER framework_agreement_revisions_delete_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'framework_agreement_revisions'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/framework_agreement_revisions_delete_guard/);
    });

    it("dropping the delegation-template DELETE guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER delegation_template_revisions_delete_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delegation_template_revisions'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/delegation_template_revisions_delete_guard/);
    });

    it("dropping the channel-policy immutability guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER ad_channel_policy_immutable_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ad_channel_policy'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/ad_channel_policy_immutable_guard/);
    });

    it("dropping the channel-policy DELETE guard still refuses, even though the table exists", () => {
      const db = fresh();
      db.exec("DROP TRIGGER ad_channel_policy_delete_guard");
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ad_channel_policy'").get()).toBeTruthy();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/ad_channel_policy_delete_guard/);
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

    it("round-trips a recorded value", () => {
      const db = fresh();
      recordAgentReferralsActivationEvidence(db, "example_key", { some: "evidence" });
      expect(agentReferralsActivationEvidence(db, "example_key")).toEqual({ some: "evidence" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get()).toEqual({ n: 1 });
    });

    it("recording the exact same value again is an idempotent no-op", () => {
      const db = fresh();
      recordAgentReferralsActivationEvidence(db, "example_key", { some: "evidence", nested: { a: 1, b: 2 } });
      expect(() => recordAgentReferralsActivationEvidence(db, "example_key", { some: "evidence", nested: { a: 1, b: 2 } })).not.toThrow();
      // Same value, different key insertion order - still recognized as identical.
      expect(() => recordAgentReferralsActivationEvidence(db, "example_key", { nested: { b: 2, a: 1 }, some: "evidence" })).not.toThrow();
      expect(agentReferralsActivationEvidence(db, "example_key")).toEqual({ some: "evidence", nested: { a: 1, b: 2 } });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get()).toEqual({ n: 1 });
    });

    it("recording a different value for an already-pinned key is refused, and the pinned value survives", () => {
      const db = fresh();
      recordAgentReferralsActivationEvidence(db, "payout_profile_encryption_key_id", "K1");
      expect(() => recordAgentReferralsActivationEvidence(db, "payout_profile_encryption_key_id", "K2"))
        .toThrow("AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT");
      expect(agentReferralsActivationEvidence(db, "payout_profile_encryption_key_id")).toBe("K1");
    });

    it("PR3 records no evidence of its own", () => {
      const db = fresh();
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get()).toEqual({ n: 0 });
    });

    describe("integration-hardening #2: structurally immutable once recorded", () => {
      it("a raw UPDATE cannot rewrite a pinned value (proven exploitable before this guard existed: it silently flipped true to false)", () => {
        const db = fresh();
        recordAgentReferralsActivationEvidence(db, "ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED", true);
        expect(() => db.prepare("UPDATE agent_referrals_activation_manifest SET value_json = 'false' WHERE key = ?").run("ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED"))
          .toThrow(/AGENT_REFERRALS_ACTIVATION_MANIFEST_IMMUTABLE/);
        expect(agentReferralsActivationEvidence(db, "ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED")).toBe(true);
      });

      it("a raw DELETE cannot remove a pinned value", () => {
        const db = fresh();
        recordAgentReferralsActivationEvidence(db, "example_key", "K1");
        expect(() => db.prepare("DELETE FROM agent_referrals_activation_manifest WHERE key = ?").run("example_key"))
          .toThrow(/AGENT_REFERRALS_ACTIVATION_MANIFEST_IMMUTABLE/);
        expect(agentReferralsActivationEvidence(db, "example_key")).toBe("K1");
      });

      it("the app's own idempotent-replay-and-conflict behavior is unchanged by the new guard", () => {
        const db = fresh();
        recordAgentReferralsActivationEvidence(db, "example_key", "K1");
        expect(() => recordAgentReferralsActivationEvidence(db, "example_key", "K1")).not.toThrow();
        expect(() => recordAgentReferralsActivationEvidence(db, "example_key", "K2")).toThrow("AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT");
      });
    });
  });
});
