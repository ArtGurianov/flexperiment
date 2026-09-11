import type Database from "better-sqlite3";
import { requireObservedVersion } from "./agent-referrals-command-precondition";
import { id } from "./crypto";

/**
 * Versioned ad-channel policy per plan section B-5b: `channel_key` is open
 * text, never a closed enum, and a channel with no applicable policy row
 * resolves to REVIEW_REQUIRED. No generic bucket key may ever read ALLOWED -
 * enforced twice: the resolver never returns ALLOWED for a reserved key
 * (it cannot, because no row for one can ever be written ALLOWED - see
 * below), and the migration's own CHECK constraint refuses the write at the
 * database layer regardless of caller.
 *
 * The resolver takes an explicit instant and picks the policy effective at
 * that instant, never "latest now" - a future distribution command will
 * classify a report against the policy that was effective at its historical
 * `published_at`, not against today's policy.
 */

export type ChannelPolicyStatus = "ALLOWED" | "BLOCKED" | "REVIEW_REQUIRED";

/** No key in this set may ever be written ALLOWED - see the migration's CHECK constraint, which enforces the same list at the database layer. */
export const RESERVED_CATCH_ALL_CHANNEL_KEYS = ["other", "other_internet_platform", "unknown", "*"] as const;

export class AgentReferralsChannelPolicyError extends Error {
  constructor(readonly code: string, readonly status = 422, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type ChannelPolicyResolution = {
  channel_key: string;
  status: ChannelPolicyStatus;
  policy_revision: number | null;
  effective_from: string | null;
};

/**
 * The policy effective for `channelKey` at `atInstant` - a deterministic
 * historical lookup, not "the latest row for this key". A channel with no
 * applicable row at that instant resolves to the REVIEW_REQUIRED fallback,
 * never to ALLOWED.
 */
export const resolveAgentReferralsChannelPolicy = (
  db: Database.Database,
  channelKey: string,
  atInstant: string,
): ChannelPolicyResolution => {
  const row = db.prepare(`SELECT status, policy_revision, effective_from FROM ad_channel_policy
    WHERE channel_key = ? AND effective_from <= ?
    ORDER BY effective_from DESC, policy_revision DESC LIMIT 1`).get(channelKey, atInstant) as
    { status: ChannelPolicyStatus; policy_revision: number; effective_from: string } | undefined;
  if (!row) return { channel_key: channelKey, status: "REVIEW_REQUIRED", policy_revision: null, effective_from: null };
  return { channel_key: channelKey, status: row.status, policy_revision: row.policy_revision, effective_from: row.effective_from };
};

/** Convenience for "what does this channel resolve to right now". */
export const resolveAgentReferralsChannelPolicyNow = (db: Database.Database, channelKey: string): ChannelPolicyResolution =>
  resolveAgentReferralsChannelPolicy(db, channelKey, new Date().toISOString());

export type SetAgentReferralsChannelPolicyInput = {
  channel_key: string;
  status: ChannelPolicyStatus;
  effective_from: string;
  reason: string;
  /** PR-C2 STALE_BOUND: the policy_revision the operator was looking at; 0 when the channel carries no policy yet. */
  expected_policy_revision: number;
};

/**
 * Mints the next policy_revision for an exact channel_key. Reviewing one
 * unknown platform and clearing it affects that exact key only - every
 * other key with no row of its own is unaffected and keeps resolving
 * REVIEW_REQUIRED, by construction of the resolver above.
 */
/** The policy_revision a channel currently carries (0 when it has no policy row) - what a caller must echo back as `expected_policy_revision`. */
export const currentAgentReferralsChannelPolicyRevision = (db: Database.Database, channelKey: string): number =>
  ((db.prepare("SELECT MAX(policy_revision) AS revision FROM ad_channel_policy WHERE channel_key = ?").get(channelKey) as { revision: number | null }).revision) ?? 0;

export const setAgentReferralsChannelPolicy = (db: Database.Database, input: SetAgentReferralsChannelPolicyInput) => {
  if (input.status === "ALLOWED" && (RESERVED_CATCH_ALL_CHANNEL_KEYS as readonly string[]).includes(input.channel_key)) {
    throw new AgentReferralsChannelPolicyError("AGENT_REFERRALS_CHANNEL_POLICY_CATCH_ALL_CANNOT_BE_ALLOWED", 422, input.channel_key);
  }

  const run = db.transaction(() => {
    const current = db.prepare(`SELECT id, policy_revision, status, effective_from FROM ad_channel_policy
      WHERE channel_key = ? ORDER BY policy_revision DESC LIMIT 1`)
      .get(input.channel_key) as { id: string; policy_revision: number; status: string; effective_from: string } | undefined;
    // PR-C2: re-stating the policy a channel already carries, from the same
    // instant, is not a second decision - it only renumbers the chain, and a
    // lost-response retry would do exactly that. `reason` is provenance and
    // stays outside the comparison, matching every other content-addressed
    // chain in this module family.
    if (current && current.status === input.status && current.effective_from === input.effective_from) {
      return { channel_key: input.channel_key, policy_revision: current.policy_revision, status: current.status, effective_from: current.effective_from };
    }

    // PR-C2 STALE_BOUND, guarding every actual mint. The no-change branch
    // above mutates nothing and so is safe for any retry; this pin is what
    // stops a retried A, arriving after a different revision B, from
    // minting a third revision that restores A's content over B's.
    requireObservedVersion("AGENT_REFERRALS_CHANNEL_POLICY_STALE", input.expected_policy_revision, current?.policy_revision ?? 0);
    const nextRevision = (current?.policy_revision ?? 0) + 1;
    db.prepare(`INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id(), input.channel_key, nextRevision, input.status, input.effective_from, input.reason);
    return { channel_key: input.channel_key, policy_revision: nextRevision, status: input.status, effective_from: input.effective_from };
  });
  return run.immediate();
};
