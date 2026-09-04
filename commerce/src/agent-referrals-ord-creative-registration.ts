import type Database from "better-sqlite3";
import { id } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { creativeRevisionById } from "./agent-referrals-creative";
import { currentOrdProviderProfile } from "./agent-referrals-ord-provider-profile";
import { ordCreativeRegistrationOperationKey } from "./agent-referrals-ord-operation-key";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Creative-registration authority (plan §B-5): one active registration per
 * creative CONTENT revision, never per engagement revision or per creative
 * authorization - so a new engagement revision that reuses the same
 * creative content reuses the same registration and ERID (L6), while a
 * changed creative_hash always mints a fresh creative revision and
 * therefore requires a fresh registration path here.
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
  lock_state: "MUTABLE" | "EXTERNALLY_LOCKED";
  evidence_ref: string | null;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = `id, creative_revision_id, engagement_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url,
  local_state, vk_submission_state, vk_external_id, vk_object_id, erid, erir_code, lock_state, evidence_ref, created_by_admin_id, created_at`;

export const ordCreativeRegistrationById = (db: Database.Database, registrationId: string): OrdCreativeRegistrationRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_creative_registrations WHERE id = ?`).get(registrationId) as OrdCreativeRegistrationRow | undefined) ?? null;

/** At most one, ever, by the migration's own UNIQUE(creative_revision_id). */
export const ordCreativeRegistrationForCreativeRevision = (db: Database.Database, creativeRevisionId: string): OrdCreativeRegistrationRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_creative_registrations WHERE creative_revision_id = ?`).get(creativeRevisionId) as OrdCreativeRegistrationRow | undefined) ?? null;

const gate = (db: Database.Database) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ORD_CREATIVE_REGISTRATION");

export type RegisterCreativeResult = { registration: OrdCreativeRegistrationRow; replayed: boolean };

/**
 * Idempotent by creative_revision_id: a second call for the SAME creative
 * revision (the L6-required "engagement revision changed, creative content
 * did not" case) returns the existing registration/ERID unchanged, never a
 * second row. The migration's own UNIQUE(creative_revision_id) is the real
 * structural backstop for a raw-SQL or concurrent duplicate attempt.
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
    const existing = ordCreativeRegistrationForCreativeRevision(db, creativeRevisionId);
    if (existing) return { registration: existing, replayed: true };

    const creative = creativeRevisionById(db, creativeRevisionId);
    if (!creative) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REVISION_NOT_FOUND", 404, creativeRevisionId);

    const counterparty = providerCounterpartyProfileId
      ? { id: providerCounterpartyProfileId }
      : currentOrdProviderProfile(db, "COUNTERPARTY");
    if (!counterparty) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_COUNTERPARTY_PROFILE_MISSING", 409);
    const contract = providerContractProfileId
      ? { id: providerContractProfileId }
      : currentOrdProviderProfile(db, "CONTRACT");
    if (!contract) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_PROVIDER_CONTRACT_PROFILE_MISSING", 409);

    const operationKey = ordCreativeRegistrationOperationKey({
      creative_revision_id: creativeRevisionId, provider_counterparty_profile_id: counterparty.id, provider_contract_profile_id: contract.id,
    });
    const registrationId = id();
    db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(registrationId, creativeRevisionId, creative.engagement_id, operationKey, counterparty.id, contract.id, creative.creative_target_url, admin.admin_id);
    return { registration: ordCreativeRegistrationById(db, registrationId)!, replayed: false };
  });
  return run.immediate();
};

/** Records that the registration was manually submitted to VK ORD - a durable fact the operator observed by hand, never a network call. */
export const recordOrdCreativeRegistrationSubmitted = (db: Database.Database, registrationId: string, vkExternalId: string, evidenceRef: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state === "EXTERNALLY_LOCKED") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED", 409, registrationId);
    const changed = db.prepare(`UPDATE ord_creative_registrations SET local_state = 'SUBMITTED', vk_submission_state = 'SUBMITTED', vk_external_id = ?, evidence_ref = ?
      WHERE id = ? AND lock_state = 'MUTABLE'`).run(vkExternalId, evidenceRef, registrationId);
    if (changed.changes !== 1) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_CONCURRENT_CONFLICT", 409, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};

/** Records the observed vk_object_id + erid VK returned, and locks the registration - the terminal, never-again-mutable fact (L6's "new ERID" boundary). */
export const confirmOrdCreativeRegistration = (db: Database.Database, registrationId: string, vkObjectId: string, erid: string, evidenceRef: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state === "EXTERNALLY_LOCKED") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED", 409, registrationId);
    const changed = db.prepare(`UPDATE ord_creative_registrations SET local_state = 'CONFIRMED', vk_object_id = ?, erid = ?, evidence_ref = ?, lock_state = 'EXTERNALLY_LOCKED'
      WHERE id = ? AND lock_state = 'MUTABLE'`).run(vkObjectId, erid, evidenceRef, registrationId);
    if (changed.changes !== 1) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_CONCURRENT_CONFLICT", 409, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};

/** Records the separate Roskomnadzor/ERIR reconciliation code - never inferred merely from ERID existing. Must land before the registration locks (EXTERNALLY_LOCKED admits no further evidence of any kind, including this). */
export const recordOrdCreativeErirReconciliation = (db: Database.Database, registrationId: string, erirCode: string): OrdCreativeRegistrationRow => {
  const run = db.transaction((): OrdCreativeRegistrationRow => {
    gate(db);
    const registration = ordCreativeRegistrationById(db, registrationId);
    if (!registration) throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_FOUND", 404, registrationId);
    if (registration.lock_state === "EXTERNALLY_LOCKED") throw new OrdCreativeRegistrationError("AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED", 409, registrationId);
    db.prepare("UPDATE ord_creative_registrations SET erir_code = ? WHERE id = ? AND lock_state = 'MUTABLE'").run(erirCode, registrationId);
    return ordCreativeRegistrationById(db, registrationId)!;
  });
  return run.immediate();
};
