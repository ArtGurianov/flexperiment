import type Database from "better-sqlite3";
import { id } from "./crypto";
import { getEngagement, lastActivatedEngagementRevision, occurrenceFacts, type EngagementRow } from "./agent-referrals-engagement";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import { revokeEngagementPromoAuthorizationInTransaction } from "./agent-referrals-promo";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-7 CLOSED: terminates forward advertising authority. Closing revokes
 * only THIS occurrence's promo authorization; the partner's permanent
 * promo stays globally ACTIVE. The CLOSED CAS+revoke+audit below is
 * written directly in this module rather than shared with a generic
 * exported transition function - §B-7 closure has real prerequisites
 * (occurrence terminal, sales closed, publication window ended,
 * reward-registry finalized, all checked above) that a shared,
 * importable "transition to CLOSED" primitive could let a future module
 * bypass; a doc comment saying "only called after these checks" is not
 * structural enforcement (Phase 5 holistic review, P0 finding 3) - the
 * identical standard already applied to agent-referrals-promo.ts's mint
 * primitive and to audience verification's REVOKED surface. Closing does
 * not wait on act, payment, NPD, VK/ERIR reporting or removal
 * verification - those continue independently afterward.
 *
 * "Reward registry finalized" is a real §B-7 prerequisite this PR cannot
 * compute for real: engagement_reward_registry_snapshot does not exist
 * until 0046 (PR6). Rather than invent substitute authority (a fabricated
 * table, a hardcoded true/false, or a numeric placeholder nothing
 * enforces - exactly the shape PR4's retention-period review rejected),
 * closeEngagement takes the resolver as a REQUIRED explicit dependency:
 * `resolveRewardRegistryFinalization`. No caller anywhere in this shipped
 * codebase can construct a real implementation of it yet (there is no
 * engagement_reward_registry_snapshot to read), so nothing in production
 * can call this function successfully today - that is the fail-closed
 * property. Tests supply a deterministic fixture resolver directly, which
 * proves every OTHER closure invariant (occurrence terminal, sales CLOSED,
 * promo-authorization revocation, one-time closure evidence) is correct
 * without inventing PR6's schema early. PR6 will supply the real resolver,
 * reading the actual registry snapshot, as a plain function of this same
 * shape - this module does not change when that happens.
 */

export type RewardRegistryFinalizationEvidence = { finalized: boolean; evidence_ref: string };
export type ResolveRewardRegistryFinalization = (db: Database.Database, engagementId: string) => RewardRegistryFinalizationEvidence;

export class EngagementClosureError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type CloseEngagementResult = { closure_event_id: string; replayed: boolean };

export const closeEngagement = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  reason: string,
  resolveRewardRegistryFinalization: ResolveRewardRegistryFinalization,
): CloseEngagementResult => {
  const run = db.transaction((): CloseEngagementResult => {
    const existing = db.prepare("SELECT id FROM engagement_closure_events WHERE engagement_id = ?").get(engagementId) as { id: string } | undefined;
    if (existing) return { closure_event_id: existing.id, replayed: true };

    const engagement: EngagementRow | null = getEngagement(db, engagementId);
    if (!engagement) throw new EngagementClosureError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    if (engagement.lifecycle_state !== "ACTIVE" && engagement.lifecycle_state !== "SUSPENDED") {
      throw new EngagementClosureError("AGENT_REFERRALS_ENGAGEMENT_ILLEGAL_TRANSITION", 409, `${engagement.lifecycle_state}->CLOSED`);
    }

    const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
    if (occurrence.fulfillment_status === "SCHEDULED") throw new EngagementClosureError("AGENT_REFERRALS_CLOSURE_OCCURRENCE_NOT_TERMINAL", 409, occurrence.fulfillment_status);
    if (occurrence.sales_status !== "CLOSED") throw new EngagementClosureError("AGENT_REFERRALS_CLOSURE_SALES_NOT_CLOSED", 409, occurrence.sales_status);

    // The revision an admin most recently ACTIVATED governs this engagement's
    // real publication window - never the latest AUTHORED (draft) one,
    // which could carry an entirely different, not-yet-relevant window
    // (Phase 5 review note 7).
    const revision = lastActivatedEngagementRevision(db, engagementId);
    if (!revision) throw new EngagementClosureError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    if (new Date(revision.publication_end_at).getTime() > Date.now()) throw new EngagementClosureError("AGENT_REFERRALS_CLOSURE_PUBLICATION_WINDOW_NOT_ENDED", 409);

    const rewardEvidence = resolveRewardRegistryFinalization(db, engagementId);
    if (!rewardEvidence.finalized) throw new EngagementClosureError("AGENT_REFERRALS_CLOSURE_REWARD_REGISTRY_FINALIZATION_UNAVAILABLE", 409);

    const changed = db.prepare(`UPDATE engagements SET lifecycle_state = 'CLOSED', lifecycle_revision = lifecycle_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lifecycle_revision = ?`)
      .run(engagementId, engagement.lifecycle_revision);
    if (changed.changes !== 1) throw new EngagementClosureError("AGENT_REFERRALS_ENGAGEMENT_REVISION_CONFLICT", 409, engagementId);
    revokeEngagementPromoAuthorizationInTransaction(db, engagementId, `ENGAGEMENT_CLOSED:${reason}`);
    recordPartnerIdentityEvent(db, engagement.partner_identity_id, "ENGAGEMENT_CLOSED", "ADMIN", { engagement_id: engagementId, reason });

    // sequence (this engagement's own durable mint order), never rowid or
    // a timestamp - the authorization this engagement most recently
    // minted, whether still live just now (ACTIVE -> CLOSED, just revoked
    // above) or already revoked earlier by a prior suspension
    // (SUSPENDED -> CLOSED, nothing live to revoke above).
    const authorization = db.prepare("SELECT id FROM engagement_promo_authorizations WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1").get(engagementId) as { id: string };

    const closureEventId = id();
    db.prepare(`INSERT INTO engagement_closure_events(id, engagement_id, occurrence_id, revoked_promo_authorization_id, reward_registry_finalization_evidence_ref, reason, closed_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(closureEventId, engagementId, occurrence.id, authorization.id, rewardEvidence.evidence_ref, reason, admin.admin_id);

    return { closure_event_id: closureEventId, replayed: false };
  });
  return run.immediate();
};
