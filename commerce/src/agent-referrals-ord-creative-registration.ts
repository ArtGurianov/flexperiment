import type Database from "better-sqlite3";
import { id } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { creativeRevisionById } from "./agent-referrals-creative";
import { currentOrdProviderProfile } from "./agent-referrals-ord-provider-profile";
import { ordCreativeRegistrationOperationKey } from "./agent-referrals-ord-operation-key";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Creative-registration authority (plan §B-5): one ACTIVE (current)
 * registration per creative CONTENT revision, never per engagement
 * revision or per creative authorization - so a new engagement revision
 * that reuses the same creative content reuses the same registration and
 * ERID (L6), while a changed creative_hash always mints a fresh creative
 * revision and therefore requires a fresh registration CHAIN.
 *
 * A REVISION CHAIN, not a single row locked forever (round-2 P0.2/P0.3
 * fix): "current" is MAX(revision) for the creative_revision_id. Before
 * confirmation the current revision is MUTABLE (ordinary in-place UPDATE);
 * once CONFIRMED it moves to CORRECTION_ONLY (frozen in place, but a
 * genuine registration-level error can still be corrected by minting the
 * NEXT revision via correctOrdCreativeRegistration - never by rewriting
 * history); an explicit lockOrdCreativeRegistration call reaches the
 * terminal EXTERNALLY_LOCKED state.
 *
 * NO PROVIDER NETWORK CALL of any kind is reachable from this module -
 * every write here is a durable MANUAL recording of a fact an operator
 * observed by hand (submitted the form, read back VK's response). There is
 * no fetch/http client, no retry/backoff, no webhook/polling.
 */

export class OrdCreativeRegistrationError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type OrdCreativeRegistrationRow = {
  id: string;
  creative_revision_id: string;
  engagement_id: string;
  revision: number;
  supersedes_registration_id: string | null;
  operation_key: string;
  provider_counterparty_profile_id: string;
  provider_contract_profile_id: string;
  registered_creative_target_url: string;
  local_state: "DRAFT" | "SUBMITTED" | "CONFIRMED";
  vk_submission_state: "NOT_SUBMITTED" | "SUBMITTED" | "SUBMIT_FAILED";
  vk_external_id: string | null;
  vk_object_id: string | null;
  erid: string | null;
  erir_code: string | null;
  erir_evidence_ref: string | null;
  evidence_ref: string | null;
  lock_state: "MUTABLE" | "CORRECTION_ONLY" | "EXTERNALLY_LOCKED";
  correction_reason: string | null;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = `id, creative_revision_id, engagement_id, revision, supersedes_registration_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id,
  registered_creative_target_url, local_state, vk_submission_state, vk_external_id, vk_object_id, erid, erir_code, erir_evidence_ref, evidence_ref, lock_state, correction_reason, created_by_admin_id, created_at`;

export const ordCreativeRegistrationById = (db: Database.Database, registrationId: string): OrdCreativeRegistrationRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_creative_registrations WHERE id = ?`).get(registrationId) as OrdCreativeRegistrationRow | undefined) ?? null;

/** "Current" (active) registration for a creative revision - MAX(revision), never a bare "the one row that exists". */
export const currentOrdCreativeRegistrationForCreativeRevision = (db: Database.Database, creativeRevisionId: string): OrdCreativeRegistrationRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_creative_registrations WHERE creative_revision_id = ? ORDER BY revision DESC LIMIT 1`)
    .get(creativeRevisionId) as OrdCreativeRegistrationRow | undefined) ?? null;

/** Back-compat name some callers/tests use for "the current registration". */
export const ordCreativeRegistrationForCreativeRevision = currentOrdCreativeRegistrationForCreativeRevision;

export const ordCreativeRegistrationHistory = (db: Database.Database, creativeRevisionId: string): OrdCreativeRegistrationRow[] =>
  db.prepare(`SELECT ${COLUMNS} FROM ord_creative_registrations WHERE creative_revision_id = ? ORDER BY revision ASC`).all(creativeRevisionId) as OrdCreativeRegistrationRow[];

const gate = (db: Database.Database) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ORD_CREATIVE_REGISTRATION");

export type RegisterCreativeResult = { registration: OrdCreativeRegistrationRow; replayed: boolean };

/**
 * Idempotent while the current revision is still DRAFT: a second call for
 * the SAME creative revision (the L6-required "engagement revision
 * changed, creative content did not" case) returns the existing DRAFT
 * registration unchanged. Once the current revision has moved past DRAFT,
 * this is a no-op replay returning that same current row (never a second
 * chain) - starting a genuine correction chain is
 * correctOrdCreativeRegistration's job, not this one's.
 */
export const registerOrdCreative = (
  db: Database.Database,
  admin: AdminPrincipal,
  creativeRevisionId: string,
  providerCounterpartyProfileId?: string,
  providerContractProfileId?: string,
): RegisterCreativeResult => {
  const run = db.transaction((): RegisterCreativeResult => {
    gate(db);
    const existing = currentOrdCreativeRegistrationForCreativeRevision(db, creativeRevisionId);
    if (existing) return { registration: existing, replayed: true };

    const creative = creativeRevisionById(db, creativeRevisionId);
    if (!creative) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REVISION_NOT_FOUND", 404, creativeRevisionId);

    const counterparty = providerCounterpartyProfileId ? { id: providerCounterpartyProfileId } : currentOrdProviderProfile(db, "COUNTERPARTY");
    if (!counterparty) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_COUNTERPARTY_PROFILE_MISSING", 409);
    const contract = providerContractProfileId ? { id: providerContractProfileId } : currentOrdProviderProfile(db, "CONTRACT");
    if (!contract) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_CONTRACT_PROFILE_MISSING", 409);

    const registrationId = id();
    const operationKey = ordCreativeRegistrationOperationKey({
      creative_revision_id: creativeRevisionId, revision: 1, provider_counterparty_profile_id: counterparty.id, provider_contract_profile_id: contract.id,
    });
    db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(registrationId, creativeRevisionId, creative.engagement_id, operationKey, counterparty.id, contract.id, creative.creative_target_url, admin.admin_id);
    return { registration: ordCreativeRegistrationById(db, registrationId)!, replayed: false };
  });
  return run.immediate();
};

/** Records that the registration was manually submitted to VK ORD - a durable fact the operator observed by hand, never a network call. Legal only while MUTABLE. */
export const recordOrdCreativeRegistrationSubmitted = (db: Database.Database, registrationId: string, vkExternalId: string, evidenceRef: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state !== "MUTABLE") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_MUTABLE", 409, registrationId);
    const changed = db.prepare(`UPDATE ord_creative_registrations SET local_state = 'SUBMITTED', vk_submission_state = 'SUBMITTED', vk_external_id = ?, evidence_ref = ?
      WHERE id = ? AND lock_state = 'MUTABLE'`).run(vkExternalId, evidenceRef, registrationId);
    if (changed.changes !== 1) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_CONCURRENT_CONFLICT", 409, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};

/**
 * Records the observed vk_object_id + erid VK returned and moves the
 * registration to CORRECTION_ONLY - this exact row is now frozen; a
 * genuine registration-level correction goes through
 * correctOrdCreativeRegistration below, never a raw re-call of this
 * function (blocked once lock_state leaves MUTABLE).
 */
export const confirmOrdCreativeRegistration = (db: Database.Database, registrationId: string, vkObjectId: string, erid: string, evidenceRef: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.local_state !== "SUBMITTED") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_SUBMITTED", 409, registrationId);
    const changed = db.prepare(`UPDATE ord_creative_registrations SET local_state = 'CONFIRMED', vk_object_id = ?, erid = ?, evidence_ref = ?, lock_state = 'CORRECTION_ONLY'
      WHERE id = ? AND lock_state = 'MUTABLE'`).run(vkObjectId, erid, evidenceRef, registrationId);
    if (changed.changes !== 1) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_CONCURRENT_CONFLICT", 409, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};

/**
 * Mints the NEXT revision for a CONFIRMED (CORRECTION_ONLY) registration,
 * carrying corrected facts - forward-only, the prior revision stays exactly
 * as filed. Never mints a new creative revision or a new registration
 * CHAIN: this is for a registration-level error only, the creative content
 * (C1) is unchanged (round-2 P0.2 fix). Requires the corrected facts to be
 * supplied directly (already known) rather than starting over at DRAFT.
 *
 * Resolves the CURRENT provider profiles at correction time (round-3 P1.3)
 * - never copies the predecessor's own (possibly by-now-superseded)
 * profile pins forward. The relational guard requires every registration
 * revision, corrections included, to pin a real CURRENT profile at its own
 * insert time; a predecessor's profile can legitimately have been
 * superseded in the time since it was filed, so reusing it here would
 * make every correction after a profile revision bump structurally
 * impossible - exactly the contradiction this fixes.
 */
export type CorrectOrdCreativeRegistrationInput = {
  vk_object_id: string; erid: string; evidence_ref: string; reason: string;
  provider_counterparty_profile_id?: string; provider_contract_profile_id?: string;
};

export const correctOrdCreativeRegistration = (db: Database.Database, admin: AdminPrincipal, registrationId: string, input: CorrectOrdCreativeRegistrationInput): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const current = ordCreativeRegistrationById(db, registrationId);
    if (!current) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (current.lock_state !== "CORRECTION_ONLY") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_CORRECTABLE", 409, registrationId);
    const latest = currentOrdCreativeRegistrationForCreativeRevision(db, current.creative_revision_id)!;
    if (latest.id !== current.id) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_STALE", 409, registrationId);

    const counterparty = input.provider_counterparty_profile_id ? { id: input.provider_counterparty_profile_id } : currentOrdProviderProfile(db, "COUNTERPARTY");
    if (!counterparty) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_COUNTERPARTY_PROFILE_MISSING", 409);
    const contract = input.provider_contract_profile_id ? { id: input.provider_contract_profile_id } : currentOrdProviderProfile(db, "CONTRACT");
    if (!contract) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_CONTRACT_PROFILE_MISSING", 409);

    const nextRegistrationId = id();
    const nextRevision = current.revision + 1;
    const operationKey = ordCreativeRegistrationOperationKey({
      creative_revision_id: current.creative_revision_id, revision: nextRevision, provider_counterparty_profile_id: counterparty.id, provider_contract_profile_id: contract.id,
    });
    db.prepare(`INSERT INTO ord_creative_registrations(
        id, creative_revision_id, engagement_id, revision, supersedes_registration_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url,
        local_state, vk_submission_state, vk_external_id, vk_object_id, erid, evidence_ref, lock_state, correction_reason, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 'SUBMITTED', ?, ?, ?, ?, 'CORRECTION_ONLY', ?, ?)`)
      .run(nextRegistrationId, current.creative_revision_id, current.engagement_id, nextRevision, current.id, operationKey, counterparty.id, contract.id,
        current.registered_creative_target_url, current.vk_external_id, input.vk_object_id, input.erid, input.evidence_ref, input.reason, admin.admin_id);
    return ordCreativeRegistrationById(db, nextRegistrationId)!;
  });
  return run.immediate();
};

/**
 * Records the separate Roskomnadzor/ERIR reconciliation code - never
 * inferred merely from ERID existing. Requires a real durable evidence_ref
 * (round-3 P0.4) and a real prior submission on file (DRAFT can never
 * carry a reconciliation fact - the migration's own CHECK backs this too).
 * NULL -> a value is the first ERIR fact; the SAME (code, evidence) again
 * is an idempotent replay; a DIFFERENT code against an already-recorded one
 * is a real conflict - the observed-id guard makes any raw historical
 * rewrite structurally impossible, so a genuine correction must go through
 * correctOrdCreativeRegistration (a new revision) instead of this function.
 */
export const recordOrdCreativeErirReconciliation = (db: Database.Database, registrationId: string, erirCode: string, evidenceRef: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state === "EXTERNALLY_LOCKED") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED", 409, registrationId);
    if (registration.local_state === "DRAFT") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_SUBMITTED", 409, registrationId);
    if (registration.erir_code !== null) {
      if (registration.erir_code === erirCode && registration.erir_evidence_ref === evidenceRef) return registration; // idempotent replay
      throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_ERIR_CONFLICT", 409, registrationId);
    }
    db.prepare("UPDATE ord_creative_registrations SET erir_code = ?, erir_evidence_ref = ? WHERE id = ?").run(erirCode, evidenceRef, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};

/**
 * Terminal: no further revision of THIS registration chain will ever be
 * minted. Explicit admin action, never implied by CONFIRMED alone. Only
 * the CURRENT (MAX(revision)) registration in the chain may ever be locked
 * (round-3 P1.4) - locking a stale revision would leave a newer
 * CORRECTION_ONLY revision still able to advance, so the chain would not
 * actually be terminal; the migration's own guard backs this structurally
 * too.
 */
export const lockOrdCreativeRegistration = (db: Database.Database, registrationId: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state !== "CORRECTION_ONLY") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_CORRECTABLE", 409, registrationId);
    const latest = currentOrdCreativeRegistrationForCreativeRevision(db, registration.creative_revision_id)!;
    if (latest.id !== registration.id) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_STALE", 409, registrationId);
    db.prepare("UPDATE ord_creative_registrations SET lock_state = 'EXTERNALLY_LOCKED' WHERE id = ? AND lock_state = 'CORRECTION_ONLY'").run(registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};
