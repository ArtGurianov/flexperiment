import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  AgentReferralsChannelPolicyError,
  RESERVED_CATCH_ALL_CHANNEL_KEYS,
  resolveAgentReferralsChannelPolicy,
  resolveAgentReferralsChannelPolicyNow,
  setAgentReferralsChannelPolicy,
} from "../src/agent-referrals-channel-policy";

const SEEDED_KEYS = ["telegram", "vk", "vk_video", "vk_clips", "youtube", "rutube", "tiktok", "likee", "twitch"];

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-channel-policy-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

describe("agent-referrals channel policy", () => {
  it("all nine seeded exact keys resolve ALLOWED now", () => {
    const db = fresh();
    for (const key of SEEDED_KEYS) {
      expect(resolveAgentReferralsChannelPolicyNow(db, key), key).toMatchObject({ status: "ALLOWED", policy_revision: 1 });
    }
  });

  it("an unknown key resolves REVIEW_REQUIRED", () => {
    const db = fresh();
    expect(resolveAgentReferralsChannelPolicyNow(db, "dzen")).toEqual({ channel_key: "dzen", status: "REVIEW_REQUIRED", policy_revision: null, effective_from: null });
  });

  it("REVIEW_REQUIRED never reads as ALLOWED (type-level and value-level distinctness)", () => {
    const db = fresh();
    const resolved = resolveAgentReferralsChannelPolicyNow(db, "dzen");
    expect(resolved.status).not.toBe("ALLOWED");
    expect(resolved.status).toBe("REVIEW_REQUIRED");
  });

  describe("reviewing and allowing dzen affects dzen only", () => {
    it("dzen reflects the new policy; another unknown key remains REVIEW_REQUIRED", () => {
      const db = fresh();
      setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "ALLOWED", effective_from: "2026-06-01T00:00:00.000Z", reason: "reviewed" });

      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2026-06-02T00:00:00.000Z")).toMatchObject({ status: "ALLOWED", policy_revision: 1 });
      expect(resolveAgentReferralsChannelPolicyNow(db, "some-other-platform")).toMatchObject({ status: "REVIEW_REQUIRED" });
      // The nine seeded keys are unaffected by the dzen review.
      for (const key of SEEDED_KEYS) expect(resolveAgentReferralsChannelPolicyNow(db, key)).toMatchObject({ status: "ALLOWED" });
    });
  });

  describe("generic catch-all bucket can never be ALLOWED", () => {
    it.each(RESERVED_CATCH_ALL_CHANNEL_KEYS)("refuses to set %s ALLOWED via the writer", (key) => {
      const db = fresh();
      expect(() => setAgentReferralsChannelPolicy(db, { channel_key: key, status: "ALLOWED", effective_from: "2026-01-01T00:00:00.000Z", reason: "attempt" }))
        .toThrow(AgentReferralsChannelPolicyError);
      expect(resolveAgentReferralsChannelPolicyNow(db, key)).toMatchObject({ status: "REVIEW_REQUIRED" });
    });

    it("still permits a reserved key to be explicitly BLOCKED or left REVIEW_REQUIRED", () => {
      const db = fresh();
      expect(() => setAgentReferralsChannelPolicy(db, { channel_key: "other", status: "BLOCKED", effective_from: "2026-01-01T00:00:00.000Z", reason: "explicit block" }))
        .not.toThrow();
      expect(resolveAgentReferralsChannelPolicyNow(db, "other")).toMatchObject({ status: "BLOCKED" });
    });
  });

  describe("historical effective-time lookup", () => {
    it("returns the policy effective at a past instant, not today's status", () => {
      const db = fresh();
      // dzen: REVIEW_REQUIRED until 2026-06-01, then ALLOWED.
      setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "ALLOWED", effective_from: "2026-06-01T00:00:00.000Z", reason: "reviewed" });

      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2026-01-01T00:00:00.000Z")).toMatchObject({ status: "REVIEW_REQUIRED", policy_revision: null });
      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2026-06-01T00:00:00.000Z")).toMatchObject({ status: "ALLOWED", policy_revision: 1 });
      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2027-01-01T00:00:00.000Z")).toMatchObject({ status: "ALLOWED", policy_revision: 1 });
    });

    it("a later revision does not retroactively change a historical resolution", () => {
      const db = fresh();
      setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "ALLOWED", effective_from: "2026-01-01T00:00:00.000Z", reason: "reviewed" });
      // A later BLOCKED revision, effective from 2026-12-01.
      setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "BLOCKED", effective_from: "2026-12-01T00:00:00.000Z", reason: "later block" });

      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2026-06-01T00:00:00.000Z")).toMatchObject({ status: "ALLOWED", policy_revision: 1 });
      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2027-01-01T00:00:00.000Z")).toMatchObject({ status: "BLOCKED", policy_revision: 2 });
    });

    it("mixes historical lookups across two channels independently", () => {
      const db = fresh();
      setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "ALLOWED", effective_from: "2026-03-01T00:00:00.000Z", reason: "reviewed" });
      setAgentReferralsChannelPolicy(db, { channel_key: "ok_ru", status: "BLOCKED", effective_from: "2026-02-01T00:00:00.000Z", reason: "blocked" });

      expect(resolveAgentReferralsChannelPolicy(db, "dzen", "2026-02-15T00:00:00.000Z")).toMatchObject({ status: "REVIEW_REQUIRED" });
      expect(resolveAgentReferralsChannelPolicy(db, "ok_ru", "2026-02-15T00:00:00.000Z")).toMatchObject({ status: "BLOCKED" });
    });
  });

  it("UNIQUE(channel_key, policy_revision) is enforced even bypassing the writer", () => {
    const db = fresh();
    expect(() => db.prepare(`INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason)
      VALUES ('dup', 'telegram', 1, 'BLOCKED', '2026-01-01T00:00:00.000Z', 'dup')`).run())
      .toThrow(/UNIQUE constraint failed/);
  });
});
