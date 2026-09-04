import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import {
  admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate,
} from "./support/agent-referrals-settlement-fixtures";
import { seedOrdProviderProfiles, readyCreative, canonicalTargetUrl, confirmedRegistration } from "./support/agent-referrals-ord-fixtures";
import { mintOrdProviderProfile } from "../src/agent-referrals-ord-provider-profile";
import {
  registerOrdCreative, recordOrdCreativeRegistrationSubmitted, confirmOrdCreativeRegistration, correctOrdCreativeRegistration, recordOrdCreativeErirReconciliation, lockOrdCreativeRegistration,
  currentOrdCreativeRegistrationForCreativeRevision, ordCreativeRegistrationHistory, OrdCreativeRegistrationError,
} from "../src/agent-referrals-ord-creative-registration";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const setup = () => {
  const { db } = fresh();
  open.push(db);
  seedOrdProviderProfiles(db);
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
  const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  const url = canonicalTargetUrl(p1.cityId, code);
  const { creativeRevisionId } = readyCreative(db, engagementId, url);
  return { db, p1, engagementId, creativeRevisionId };
};

describe("registerOrdCreative: creative-registration authority (revision chain)", () => {
  it("mints a DRAFT/MUTABLE revision-1 registration pinned to the current provider profiles", () => {
    const { db, creativeRevisionId } = setup();
    const { registration, replayed } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(replayed).toBe(false);
    expect(registration.creative_revision_id).toBe(creativeRevisionId);
    expect(registration.revision).toBe(1);
    expect(registration.supersedes_registration_id).toBeNull();
    expect(registration.local_state).toBe("DRAFT");
    expect(registration.lock_state).toBe("MUTABLE");
    expect(registration.erid).toBeNull();
  });

  it("is idempotent while still DRAFT: a second call for the SAME creative revision returns the SAME draft row", () => {
    const { db, creativeRevisionId } = setup();
    const first = registerOrdCreative(db, admin, creativeRevisionId);
    const second = registerOrdCreative(db, admin, creativeRevisionId);
    expect(second.replayed).toBe(true);
    expect(second.registration.id).toBe(first.registration.id);
  });

  it("is idempotent once CONFIRMED too (L6: engagement revision changed, content did not) - returns the SAME current registration/ERID, never a second chain", () => {
    const { db, creativeRevisionId } = setup();
    const confirmed = confirmedRegistration(db, creativeRevisionId);
    const replay = registerOrdCreative(db, admin, creativeRevisionId);
    expect(replay.replayed).toBe(true);
    expect(replay.registration.id).toBe(confirmed.id);
    expect(replay.registration.erid).toBe(confirmed.erid);
  });

  it("a changed creative_hash (new engagement_creative_revisions row) always requires a NEW registration CHAIN - never reuses an ERID", () => {
    const { db, engagementId, creativeRevisionId, p1 } = setup();
    const confirmed = confirmedRegistration(db, creativeRevisionId);
    const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const { creativeRevisionId: c2 } = readyCreative(db, engagementId, canonicalTargetUrl(p1.cityId, code), "story");
    expect(c2).not.toBe(creativeRevisionId);
    const second = registerOrdCreative(db, admin, c2);
    expect(second.replayed).toBe(false);
    expect(second.registration.id).not.toBe(confirmed.id);
    expect(second.registration.revision).toBe(1);
    expect(second.registration.erid).toBeNull();
  });

  it("two concurrent revision-1 registration attempts for the SAME creative revision: one loses structurally (UNIQUE(creative_revision_id, revision))", () => {
    const { db, creativeRevisionId } = setup();
    registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      SELECT ?, creative_revision_id, engagement_id, 1, 'different-op-key', provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id
      FROM ord_creative_registrations WHERE creative_revision_id = ?`).run(randomUUID(), creativeRevisionId)).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses under DORMANT", () => {
    const { db } = fresh(); open.push(db);
    expect(() => registerOrdCreative(db, admin, "nonexistent")).toThrow(/AGENT_REFERRALS_FEATURE_DORMANT/);
  });

  it("refuses under SUSPENDED, even completing an already-DRAFT registration", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "pause" });
    expect(() => recordOrdCreativeRegistrationSubmitted(db, registration.id, "vk-ext-1", "ev")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
  });
});

describe("submit -> confirm -> CORRECTION_ONLY lifecycle", () => {
  it("submitted -> confirmed: the full manual pre-correction lifecycle", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    const submitted = recordOrdCreativeRegistrationSubmitted(db, registration.id, "vk-ext-1", "ev-submit");
    expect(submitted.vk_submission_state).toBe("SUBMITTED");
    expect(submitted.local_state).toBe("SUBMITTED");
    expect(submitted.lock_state).toBe("MUTABLE");
    const confirmed = confirmOrdCreativeRegistration(db, registration.id, "vk-obj-1", "erid-1", "ev-confirm");
    expect(confirmed.local_state).toBe("CONFIRMED");
    expect(confirmed.lock_state).toBe("CORRECTION_ONLY");
    expect(confirmed.erid).toBe("erid-1");
  });

  it("confirmOrdCreativeRegistration refuses before a real submission", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => confirmOrdCreativeRegistration(db, registration.id, "vk-obj-1", "erid-1", "ev")).toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_SUBMITTED/);
  });

  it("once CORRECTION_ONLY, no raw field edit is legal - only the one-way transition to EXTERNALLY_LOCKED", () => {
    const { db, creativeRevisionId } = setup();
    const confirmed = confirmedRegistration(db, creativeRevisionId);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET evidence_ref = 'x' WHERE id = ?").run(confirmed.id)).toThrow(/ORD_CREATIVE_REGISTRATION_CORRECTION_ONLY/);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET erid = 'different-erid' WHERE id = ?").run(confirmed.id)).toThrow(/ORD_CREATIVE_REGISTRATION_(CORRECTION_ONLY|OBSERVED_ID_IMMUTABLE)/);
  });

  it("a provider-observed id, once set, can never be overwritten to a different value (raw SQL) - even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    recordOrdCreativeRegistrationSubmitted(db, registration.id, "vk-ext-1", "ev");
    expect(() => db.prepare("UPDATE ord_creative_registrations SET vk_external_id = 'vk-ext-REWRITTEN' WHERE id = ?").run(registration.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_OBSERVED_ID_IMMUTABLE/);
  });

  it("authority columns (creative_revision_id, engagement_id, revision, operation_key, provider profile pins) are DB-immutable even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET operation_key = 'different' WHERE id = ?").run(registration.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_AUTHORITY_COLUMNS_IMMUTABLE/);
  });

  it("refuses a raw INSERT naming a registered_creative_target_url that disagrees with the creative's own creative_target_url", () => {
    const { db, creativeRevisionId, engagementId } = setup();
    const counterparty = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY'").get() as { id: string };
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      VALUES (?, ?, ?, 1, 'op-1', ?, ?, 'https://wrong-url.example', 'admin')`).run(randomUUID(), creativeRevisionId, engagementId, counterparty.id, contract.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a raw INSERT pinning a STALE (superseded) provider profile revision", () => {
    const { db, creativeRevisionId, engagementId } = setup();
    const staleCounterparty = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY'").get() as { id: string };
    mintOrdProviderProfile(db, "admin", "COUNTERPARTY", { legal_name: "Flexperiment LLC v2" }, "revision 2");
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    const creative = db.prepare("SELECT creative_target_url FROM engagement_creative_revisions WHERE id = ?").get(creativeRevisionId) as { creative_target_url: string };
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      VALUES (?, ?, ?, 1, 'op-stale', ?, ?, ?, 'admin')`).run(randomUUID(), creativeRevisionId, engagementId, staleCounterparty.id, contract.id, creative.creative_target_url))
      .toThrow(/ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT/);
  });

  it("delete is never legal, even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => db.prepare("DELETE FROM ord_creative_registrations WHERE id = ?").run(registration.id)).toThrow(/ORD_CREATIVE_REGISTRATION_IMMUTABLE/);
  });
});

describe("correctOrdCreativeRegistration: forward-only registration-level correction (round-2 P0.2)", () => {
  it("mints revision 2 for the SAME creative_revision_id, correcting a registration-level error - the creative content never changes", () => {
    const { db, creativeRevisionId } = setup();
    const reg1 = confirmedRegistration(db, creativeRevisionId);
    const reg2 = correctOrdCreativeRegistration(db, admin, reg1.id, { vk_object_id: "vk-obj-corrected", erid: "erid-corrected", evidence_ref: "correction evidence", reason: "operator mis-transcribed the ERID" });
    expect(reg2.creative_revision_id).toBe(creativeRevisionId);
    expect(reg2.revision).toBe(2);
    expect(reg2.supersedes_registration_id).toBe(reg1.id);
    expect(reg2.erid).toBe("erid-corrected");
    expect(reg2.local_state).toBe("CONFIRMED");
    expect(reg2.lock_state).toBe("CORRECTION_ONLY");

    // reg1 stays exactly as filed, forever.
    const reg1After = ordCreativeRegistrationHistory(db, creativeRevisionId).find((r) => r.id === reg1.id)!;
    expect(reg1After.erid).toBe(reg1.erid);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET erid = 'x' WHERE id = ?").run(reg1.id)).toThrow(/ORD_CREATIVE_REGISTRATION_(TERMINAL_IMMUTABLE|CORRECTION_ONLY|OBSERVED_ID_IMMUTABLE)/);

    // "Current" now resolves to reg2.
    expect(currentOrdCreativeRegistrationForCreativeRevision(db, creativeRevisionId)!.id).toBe(reg2.id);
  });

  it("refuses to correct a still-MUTABLE (never confirmed) registration - ordinary edits go through the submit/confirm functions instead", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => correctOrdCreativeRegistration(db, admin, registration.id, { vk_object_id: "x", erid: "y", evidence_ref: "z", reason: "n/a" }))
      .toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_CORRECTABLE/);
  });

  it("refuses to correct a STALE (already-superseded) registration revision - only the current one may be corrected", () => {
    const { db, creativeRevisionId } = setup();
    const reg1 = confirmedRegistration(db, creativeRevisionId);
    correctOrdCreativeRegistration(db, admin, reg1.id, { vk_object_id: "vk-obj-2", erid: "erid-2", evidence_ref: "ev2", reason: "first correction" });
    expect(() => correctOrdCreativeRegistration(db, admin, reg1.id, { vk_object_id: "vk-obj-3", erid: "erid-3", evidence_ref: "ev3", reason: "attempted from stale reg1" }))
      .toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_STALE/);
  });

  it("a raw INSERT of revision 2 naming a predecessor that was NOT itself CORRECTION_ONLY (still MUTABLE) is refused", () => {
    const { db, creativeRevisionId, engagementId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId); // stays MUTABLE
    const counterparty = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY'").get() as { id: string };
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    const creative = db.prepare("SELECT creative_target_url FROM engagement_creative_revisions WHERE id = ?").get(creativeRevisionId) as { creative_target_url: string };
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, supersedes_registration_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url,
        local_state, vk_submission_state, vk_external_id, vk_object_id, erid, evidence_ref, lock_state, correction_reason, created_by_admin_id)
      VALUES (?, ?, ?, 2, ?, 'op-badpred', ?, ?, ?, 'CONFIRMED', 'SUBMITTED', 'x', 'y', 'z', 'ev', 'CORRECTION_ONLY', 'bad', 'admin')`)
      .run(randomUUID(), creativeRevisionId, engagementId, registration.id, counterparty.id, contract.id, creative.creative_target_url))
      .toThrow(/ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT/);
  });

  it("a raw INSERT of revision 2 naming a predecessor from a DIFFERENT creative revision is refused (cross-chain)", () => {
    const { db, creativeRevisionId, engagementId, p1 } = setup();
    const reg1 = confirmedRegistration(db, creativeRevisionId);
    const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const { creativeRevisionId: c2 } = readyCreative(db, engagementId, canonicalTargetUrl(p1.cityId, code), "story");
    const counterparty = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY'").get() as { id: string };
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    const creative2 = db.prepare("SELECT creative_target_url FROM engagement_creative_revisions WHERE id = ?").get(c2) as { creative_target_url: string };
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, revision, supersedes_registration_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url,
        local_state, vk_submission_state, vk_external_id, vk_object_id, erid, evidence_ref, lock_state, correction_reason, created_by_admin_id)
      VALUES (?, ?, ?, 2, ?, 'op-cross', ?, ?, ?, 'CONFIRMED', 'SUBMITTED', 'x', 'y', 'z', 'ev', 'CORRECTION_ONLY', 'bad', 'admin')`)
      // reg1 belongs to `creativeRevisionId`, but this row claims creative_revision_id = c2.
      .run(randomUUID(), c2, engagementId, reg1.id, counterparty.id, contract.id, creative2.creative_target_url))
      .toThrow(/ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT/);
  });
});

describe("recordOrdCreativeErirReconciliation / lockOrdCreativeRegistration", () => {
  it("erir_code is independent of vk_submission_state/erid and legal any time before EXTERNALLY_LOCKED", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    const withErir = recordOrdCreativeErirReconciliation(db, registration.id, "erir-early");
    expect(withErir.erir_code).toBe("erir-early");
    expect(withErir.local_state).toBe("DRAFT"); // unaffected
  });

  it("lockOrdCreativeRegistration reaches the terminal EXTERNALLY_LOCKED state - only reachable from CORRECTION_ONLY", () => {
    const { db, creativeRevisionId } = setup();
    const confirmed = confirmedRegistration(db, creativeRevisionId);
    const locked = lockOrdCreativeRegistration(db, confirmed.id);
    expect(locked.lock_state).toBe("EXTERNALLY_LOCKED");
    expect(() => correctOrdCreativeRegistration(db, admin, locked.id, { vk_object_id: "x", erid: "y", evidence_ref: "z", reason: "n/a" }))
      .toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_CORRECTABLE/);
  });

  it("refuses lockOrdCreativeRegistration on a still-MUTABLE registration", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => lockOrdCreativeRegistration(db, registration.id)).toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_NOT_CORRECTABLE/);
  });

  it("once EXTERNALLY_LOCKED, no UPDATE of any kind is legal, including recording erir_code", () => {
    const { db, creativeRevisionId } = setup();
    const confirmed = confirmedRegistration(db, creativeRevisionId);
    const locked = lockOrdCreativeRegistration(db, confirmed.id);
    expect(() => recordOrdCreativeErirReconciliation(db, locked.id, "erir-1")).toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED/);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET erir_code = 'x' WHERE id = ?").run(locked.id)).toThrow(/ORD_CREATIVE_REGISTRATION_TERMINAL_IMMUTABLE/);
  });
});

describe("errors", () => {
  it("OrdCreativeRegistrationError carries a code and status", () => {
    const err = new OrdCreativeRegistrationError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });

  it("currentOrdCreativeRegistrationForCreativeRevision returns null for an unregistered creative", () => {
    const { db, creativeRevisionId } = setup();
    expect(currentOrdCreativeRegistrationForCreativeRevision(db, creativeRevisionId)).toBeNull();
  });
});
