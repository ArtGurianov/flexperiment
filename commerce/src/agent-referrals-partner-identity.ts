import type Database from "better-sqlite3";
import { emailHash, id } from "./crypto";
import { requireObservedVersion } from "./agent-referrals-command-precondition";
import { normalizeAndValidateLegalProfile, type LegalForm, type RawLegalRequisitesInput, type TaxMode } from "./agent-referrals-legal-profile";
import { applyVerifiedLegalProfileForPartnerIdentity } from "./agent-referrals-legal-profile-supersession";
import { getPartnerIdentity, recordPartnerIdentityEvent, transitionOnboardingStateInTransaction, type PartnerIdentityRow } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { generateOpaqueToken, hashOpaqueToken } from "./agent-referrals-partner-auth";

/**
 * Explicit authority types, never raw ids as a substitute for
 * authentication. Every partner-realm command below takes one of these.
 */
export type AdminPrincipal = { readonly realm: "ADMIN"; readonly admin_id: string };
export type PartnerPrincipal = { readonly realm: "PARTNER"; readonly partner_identity_id: string; readonly partner_session_id: string };

export class PartnerIdentityError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Admin-only provisioning, gated on the existing PR3 foundation authority:
 * NEW_PARTNER_PROVISIONING is refused under global DORMANT/SUSPENDED. The
 * "exactly one OWNER per partner" concurrency property comes structurally
 * from `agents.id` -> `partner_identities.agent_id` UNIQUE: two concurrent
 * provisioning attempts for the same agent serialize on SQLite's write lock,
 * and the second INSERT hits the UNIQUE constraint and rolls back its own
 * transaction whole - never leaving a partial invite row, because the
 * identity insert and the invite mint are one transaction together.
 */
export type ProvisionPartnerResult = { partner_identity_id: string; invite_id: string; raw_invite_token: string };

export const provisionPartnerOwner = (db: Database.Database, admin: AdminPrincipal, agentId: string, email: string, reason: string): ProvisionPartnerResult => {
  const run = db.transaction((): ProvisionPartnerResult => {
    // Read and asserted INSIDE the transaction, not before it: a read
    // taken before BEGIN IMMEDIATE observes state that can change before
    // this connection actually acquires the write lock. A contender that
    // observed ACTIVE just before a SUSPENDED transition commits must
    // re-read SUSPENDED once it is actually holding the lock, exactly the
    // race the migration runner's own "re-check inside the transaction"
    // pattern (commerce/src/db.ts) exists to close.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "NEW_PARTNER_PROVISIONING");

    const partnerIdentityId = id();
    try {
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, ?, ?, ?)`)
        .run(partnerIdentityId, agentId, email.trim().toLowerCase(), emailHash(email), admin.admin_id);
    } catch (error) {
      // PR-C idempotency audit: this command carries no durable key, so the
      // ONLY thing a retry after an ambiguous network failure meets is the
      // agent_id UNIQUE index - and it met it as a raw SqliteError, i.e. a
      // 500 for what is really "this agent already has a partner". The
      // operator's correct next move (re-read, see the partner, stop) was
      // being reported as a server fault. Narrow catch by the exact
      // constraint, per agent-referrals-payment.ts's own precedent.
      if (error instanceof Error && /UNIQUE constraint failed: partner_identities\.agent_id/.test(error.message)) {
        throw new PartnerIdentityError("AGENT_REFERRALS_PARTNER_ALREADY_PROVISIONED", 409, agentId);
      }
      throw error;
    }

    const rawToken = generateOpaqueToken();
    const inviteId = id();
    db.prepare(`INSERT INTO partner_invite_capabilities(id, partner_identity_id, purpose, verifier_hash, expires_at, created_by_admin_id)
      VALUES (?, ?, 'ONBOARDING', ?, ?, ?)`)
      .run(inviteId, partnerIdentityId, hashOpaqueToken(rawToken), new Date(Date.now() + INVITE_TTL_MS).toISOString(), admin.admin_id);

    recordPartnerIdentityEvent(db, partnerIdentityId, "PARTNER_PROVISIONED", "ADMIN", { agent_id: agentId, reason });
    recordPartnerIdentityEvent(db, partnerIdentityId, "INVITE_ISSUED", "ADMIN", { invite_id: inviteId });
    // Never log or persist the raw token beyond this in-memory return value.
    return { partner_identity_id: partnerIdentityId, invite_id: inviteId, raw_invite_token: rawToken };
  });
  return run.immediate();
};

/**
 * The one capability that is live for a partner right now, or null. The
 * partial unique index (0044) guarantees at most one, so this is a single
 * value rather than a list - and it is what both issuance commands below are
 * pinned against.
 */
export const liveInviteCapabilityId = (db: Database.Database, partnerIdentityId: string): string | null =>
  ((db.prepare(`SELECT id FROM partner_invite_capabilities
    WHERE partner_identity_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND superseded_by_id IS NULL`)
    .get(partnerIdentityId) as { id: string } | undefined)?.id) ?? null;

/**
 * PR-C3: rotating a partner's invite capability - the ONE operation, with a
 * reason rather than a twin.
 *
 * The defect this exists for is small and real:
 *
 *   T1 live
 *   reissue(T1) commits -> T2, raw token in the response
 *   the response is lost
 *   the old reissue(T1) must not destroy T2
 *
 * and it needs exactly one new invariant: a rotation must NAME the
 * capability it replaces. Before this, reissue read whatever was live and
 * superseded it, so a retry minted a THIRD capability and destroyed the
 * second - whose raw token nobody held either. At every instant exactly one
 * capability was live, so 0044's partial unique index was satisfied and
 * nothing looked wrong.
 *
 * Recovery is NOT a second mechanism. The raw token is never persisted, so
 * restoring a lost response is impossible in principle; the only thing that
 * can exist is "rotate again, deliberately". What differs between an
 * operator reissuing and an operator recovering a lost response is the
 * REASON, which the audit trail records - not the state machine, not the
 * transaction, not the error. An earlier draft of this PR split them into
 * two exported commands and two routes that differed by one string literal;
 * that was two concepts where there is one.
 *
 * A retried old request simply meets the stale refusal. There is no
 * idempotency infrastructure here, and there should not be.
 */
export type InviteRotationReason = "MANUAL_REISSUE" | "LOST_RESPONSE_RECOVERY";

export const rotatePartnerInvite = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  /** The live capability this rotation replaces, as the caller last saw it; null only when none is live. */
  expectedLiveCapabilityId: string | null,
  rotationReason: InviteRotationReason,
  reason: string,
): { invite_id: string; raw_invite_token: string } => {
  const run = db.transaction(() => {
    const current = liveInviteCapabilityId(db, partnerIdentityId);
    requireObservedVersion("AGENT_REFERRALS_INVITE_CAPABILITY_STALE", expectedLiveCapabilityId, current);

    const rawToken = generateOpaqueToken();
    const inviteId = id();

    // The old row must stop matching the partial unique index's predicate
    // (superseded_by_id IS NULL) BEFORE the new row is inserted, or the two
    // would momentarily both be "active" and collide on it - but the old
    // row's superseded_by_id has to reference the new row's id, which does
    // not exist until the INSERT below runs. defer_foreign_keys pushes that
    // FK's check to commit time (SQLite resets it automatically at the end
    // of the transaction), which is what lets these two writes happen in
    // the only order the unique index permits.
    db.pragma("defer_foreign_keys = ON");
    if (current) db.prepare(`UPDATE partner_invite_capabilities SET superseded_by_id = ? WHERE id = ?`).run(inviteId, current);

    db.prepare(`INSERT INTO partner_invite_capabilities(id, partner_identity_id, purpose, verifier_hash, expires_at, created_by_admin_id)
      VALUES (?, ?, 'ONBOARDING', ?, ?, ?)`)
      .run(inviteId, partnerIdentityId, hashOpaqueToken(rawToken), new Date(Date.now() + INVITE_TTL_MS).toISOString(), admin.admin_id);

    // One audit stream, and the reason is what makes a recovery
    // distinguishable from a deliberate reissue. Never the raw token, which
    // exists solely in the value returned below.
    recordPartnerIdentityEvent(db, partnerIdentityId, "INVITE_ROTATED", "ADMIN", {
      invite_id: inviteId, superseded_invite_id: current, rotation_reason: rotationReason, reason,
    });
    return { invite_id: inviteId, raw_invite_token: rawToken };
  });
  return run.immediate();
};

export const revokePartnerInvite = (db: Database.Database, admin: AdminPrincipal, inviteId: string, reason: string): void => {
  const run = db.transaction(() => {
    const changed = db.prepare(`UPDATE partner_invite_capabilities SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL`).run(inviteId);
    if (changed.changes !== 1) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_NOT_REVOCABLE", 409, inviteId);
    const row = db.prepare("SELECT partner_identity_id FROM partner_invite_capabilities WHERE id = ?").get(inviteId) as { partner_identity_id: string };
    recordPartnerIdentityEvent(db, row.partner_identity_id, "INVITE_REVOKED", "ADMIN", { invite_id: inviteId, reason });
  });
  run.immediate();
};

/**
 * Atomic consumption, re-checked inside its own transaction: a replay after
 * a successful consume fails closed on the same CAS UPDATE that a genuine
 * race would fail on. Never returns anything about WHY a token failed
 * beyond a coarse code, and never re-derives or logs the raw token.
 */
export const consumePartnerInvite = (db: Database.Database, rawToken: string): { partner_identity_id: string; invite_id: string } => {
  const verifierHash = hashOpaqueToken(rawToken);
  const run = db.transaction(() => {
    const invite = db.prepare(`SELECT id, partner_identity_id, expires_at, consumed_at, revoked_at, superseded_by_id
      FROM partner_invite_capabilities WHERE verifier_hash = ?`).get(verifierHash) as
      { id: string; partner_identity_id: string; expires_at: string; consumed_at: string | null; revoked_at: string | null; superseded_by_id: string | null } | undefined;
    if (!invite) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_NOT_FOUND", 404);
    if (invite.revoked_at) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_REVOKED", 409);
    if (invite.superseded_by_id) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_SUPERSEDED", 409);
    if (invite.consumed_at) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_ALREADY_CONSUMED", 409);
    if (new Date(invite.expires_at).getTime() <= Date.now()) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_EXPIRED", 409);

    const changed = db.prepare(`UPDATE partner_invite_capabilities SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL`).run(invite.id);
    if (changed.changes !== 1) throw new PartnerIdentityError("AGENT_REFERRALS_INVITE_ALREADY_CONSUMED", 409);

    recordPartnerIdentityEvent(db, invite.partner_identity_id, "INVITE_CONSUMED", "PARTNER", { invite_id: invite.id });
    return { partner_identity_id: invite.partner_identity_id, invite_id: invite.id };
  });
  return run.immediate();
};

/**
 * Partner's mutable draft claim. Gated on onboarding_state: writable only
 * while INVITED or PROFILE_SUBMITTED, locked the instant an admin verifies
 * it - the partner cannot mutate a claim that already produced evidence.
 * Transitions INVITED -> PROFILE_SUBMITTED on first submission; a later
 * resubmission while already PROFILE_SUBMITTED updates the draft without
 * consuming another onboarding transition.
 *
 * PR-E: the FULL requisites payload is required and validated through the
 * exact same matrix normalizeAndValidateLegalProfile enforces on the mint
 * path itself - an incomplete or malformed draft can never reach
 * PROFILE_SUBMITTED, so verifyPartnerLegalProfile's later mint can never
 * fail on a requisites shape violation the partner wasn't already told
 * about at submission time.
 */
export const submitPartnerLegalProfile = (
  db: Database.Database,
  partner: PartnerPrincipal,
  legalForm: LegalForm,
  taxMode: TaxMode,
  requisites: RawLegalRequisitesInput,
  /**
   * PR-C2 STALE_BOUND: the draft revision the partner was looking at. The
   * no-change branch below is NOT a replay proof on its own - after a
   * second, different submission the candidate no longer equals the current
   * draft, so a retried first submission would silently overwrite the
   * second one and an admin verifying "the submitted profile" would verify
   * the draft the partner had already replaced.
   */
  expectedDraftRevision: number,
): PartnerIdentityRow => {
  const { requisites: validated } = normalizeAndValidateLegalProfile(legalForm, taxMode, requisites);
  const run = db.transaction((): PartnerIdentityRow => {
    const identity = getPartnerIdentity(db, partner.partner_identity_id);
    // A PartnerPrincipal is resolved from a session BEFORE this transaction
    // opens (the session lookup itself already refuses a destroyed identity,
    // but a principal obtained just before a concurrent destroy is still a
    // valid-looking value the caller holds) - destroyed_at must be re-proven
    // here, inside the write lock, or a stale principal could resurrect the
    // exact PII destroyPartnerIdentity() just scrubbed. 404, matching the
    // "identity does not exist" treatment used everywhere else in this file -
    // a destroyed identity is not a distinguishable state to an unauthorized
    // caller.
    if (!identity || identity.destroyed_at !== null) throw new PartnerIdentityError("PARTNER_IDENTITY_NOT_FOUND", 404);
    if (identity.onboarding_state !== "INVITED" && identity.onboarding_state !== "PROFILE_SUBMITTED") {
      throw new PartnerIdentityError("AGENT_REFERRALS_LEGAL_PROFILE_SUBMISSION_LOCKED", 409, identity.onboarding_state);
    }
    // Proven against the aggregate's own monotone counter (0055), never
    // against the draft's content: X -> Y -> X is a legal sequence of edits
    // and a content pin would match again at the end of it.
    requireObservedVersion("AGENT_REFERRALS_LEGAL_PROFILE_DRAFT_STALE", expectedDraftRevision, identity.legal_profile_draft_revision);

    // PR-C2: resubmitting the draft the identity already carries is not a
    // second submission. The old path rewrote the same columns and appended
    // another LEGAL_PROFILE_SUBMITTED event every time - and the partner form
    // stays on screen in PROFILE_SUBMITTED, so a lost response plus one more
    // click reached it normally. Mirrors applyAgentReferralsLegalProfile's
    // own idempotent no-op on an unchanged semantic profile.
    const unchanged = identity.onboarding_state === "PROFILE_SUBMITTED"
      && identity.submitted_legal_form === legalForm && identity.submitted_tax_mode === taxMode
      && identity.submitted_opf === validated.opf && identity.submitted_full_name === validated.full_name
      && identity.submitted_short_name === validated.short_name && identity.submitted_inn === validated.inn
      && identity.submitted_kpp === validated.kpp && identity.submitted_registration_number === validated.registration_number
      && identity.submitted_legal_address === validated.legal_address;
    if (unchanged) return identity;

    db.prepare(`UPDATE partner_identities SET submitted_legal_form = ?, submitted_tax_mode = ?,
        submitted_opf = ?, submitted_full_name = ?, submitted_short_name = ?, submitted_inn = ?, submitted_kpp = ?, submitted_registration_number = ?, submitted_legal_address = ?,
        legal_profile_draft_revision = legal_profile_draft_revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(legalForm, taxMode, validated.opf, validated.full_name, validated.short_name, validated.inn, validated.kpp, validated.registration_number, validated.legal_address, partner.partner_identity_id);
    recordPartnerIdentityEvent(db, partner.partner_identity_id, "LEGAL_PROFILE_SUBMITTED", "PARTNER", { legal_form: legalForm, tax_mode: taxMode });
    if (identity.onboarding_state === "INVITED") {
      transitionOnboardingStateInTransaction(db, partner.partner_identity_id, "PROFILE_SUBMITTED", identity.onboarding_revision, "PARTNER", "legal profile submitted");
    }
    return getPartnerIdentity(db, partner.partner_identity_id)!;
  });
  return run.immediate();
};

/**
 * Admin-only verification: partner cannot self-verify (there is no partner-
 * callable path to this function at all - it takes an AdminPrincipal).
 * Commits the PR3 legal-profile evidence (preserving the frozen 4/2 matrix
 * and legacy contractor_type projection unchanged) and the onboarding
 * transition to PROFILE_VERIFIED atomically with it.
 */
export const verifyPartnerLegalProfile = (db: Database.Database, admin: AdminPrincipal, partnerIdentityId: string, reason: string): PartnerIdentityRow => {
  const run = db.transaction((): PartnerIdentityRow => {
    // D2: everything that moves the verified MAX(revision) is classified
    // NEW_AUTHORITY, gated the same as D2's own supersession verify() -
    // this initial mint was the pre-D2 gap in that rule.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "INITIAL_LEGAL_PROFILE_VERIFICATION");

    const identity = getPartnerIdentity(db, partnerIdentityId);
    // Explicit, not merely implied by the submitted_full_name/inn NULL check
    // below: a destroyed identity must never become new legal authority,
    // independent of whatever the draft columns happen to contain - matches
    // D2's own eligibleForSupersession (agent-referrals-legal-profile-
    // supersession.ts), which checks destroyed_at the same way for its own
    // verify path.
    if (!identity || identity.destroyed_at !== null) throw new PartnerIdentityError("PARTNER_IDENTITY_NOT_FOUND", 404);
    if (identity.onboarding_state !== "PROFILE_SUBMITTED") throw new PartnerIdentityError("AGENT_REFERRALS_LEGAL_PROFILE_NOT_SUBMITTED", 409, identity.onboarding_state);
    // full_name/inn are mandatory for every legal_form - their absence is
    // sufficient proof the draft was never (successfully) submitted through
    // submitPartnerLegalProfile, which validates the whole matrix before
    // ever writing these columns.
    if (!identity.submitted_legal_form || !identity.submitted_tax_mode || !identity.submitted_full_name || !identity.submitted_inn) {
      throw new PartnerIdentityError("AGENT_REFERRALS_LEGAL_PROFILE_NOT_SUBMITTED", 409);
    }

    const revisionResult = applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId,
      legalForm: identity.submitted_legal_form as LegalForm,
      taxMode: identity.submitted_tax_mode as TaxMode,
      reason,
      // The admin only verifies; the asserted profile is the partner's own
      // submitted draft (submitted_legal_form/_tax_mode above), so the
      // provenance is PARTNER_ASSERTED, not ADMIN_ASSERTED.
      assertionSource: "PARTNER_ASSERTED",
      // The whole proven snapshot, carried straight through - never
      // re-collected or re-derived at verify time.
      opf: identity.submitted_opf, full_name: identity.submitted_full_name, short_name: identity.submitted_short_name,
      inn: identity.submitted_inn, kpp: identity.submitted_kpp, registration_number: identity.submitted_registration_number, legal_address: identity.submitted_legal_address,
    });

    recordPartnerIdentityEvent(db, partnerIdentityId, "LEGAL_PROFILE_VERIFIED", "ADMIN", { legal_profile_revision_id: revisionResult.revision_id, reason });
    transitionOnboardingStateInTransaction(db, partnerIdentityId, "PROFILE_VERIFIED", identity.onboarding_revision, "ADMIN", reason);
    return getPartnerIdentity(db, partnerIdentityId)!;
  });
  return run.immediate();
};

/**
 * Admin-only: pins the EXACT pair of template revisions being issued into
 * immutable framework_issuances, atomically with the onboarding transition.
 * This pinned pair is the authority acceptFrameworkAndDelegation() checks
 * against - without it, a partner could request step-up for and accept a
 * different pair than the one an admin actually issued, since the
 * onboarding state alone only gates WHEN acceptance may happen, never
 * WHICH revisions it may be for.
 */
export const issueFrameworkToPartner = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  frameworkAgreementRevisionId: string,
  delegationTemplateRevisionId: string,
  reason: string,
): PartnerIdentityRow => {
  const run = db.transaction((): PartnerIdentityRow => {
    const identity = getPartnerIdentity(db, partnerIdentityId);
    if (!identity) throw new PartnerIdentityError("PARTNER_IDENTITY_NOT_FOUND", 404);
    const issuanceId = id();
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id)
      VALUES (?, ?, ?, ?, ?)`)
      .run(issuanceId, partnerIdentityId, frameworkAgreementRevisionId, delegationTemplateRevisionId, admin.admin_id);
    transitionOnboardingStateInTransaction(db, partnerIdentityId, "FRAMEWORK_ISSUED", identity.onboarding_revision, "ADMIN", reason);
    recordPartnerIdentityEvent(db, partnerIdentityId, "FRAMEWORK_ISSUED_TO_PARTNER", "ADMIN", {
      issuance_id: issuanceId, framework_agreement_revision_id: frameworkAgreementRevisionId, delegation_template_revision_id: delegationTemplateRevisionId, reason,
    });
    return getPartnerIdentity(db, partnerIdentityId)!;
  });
  return run.immediate();
};
