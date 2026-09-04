import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import {
  admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate,
} from "./support/agent-referrals-settlement-fixtures";
import { seedOrdProviderProfiles, readyCreative, canonicalTargetUrl } from "./support/agent-referrals-ord-fixtures";
import {
  registerOrdCreative, recordOrdCreativeRegistrationSubmitted, confirmOrdCreativeRegistration, recordOrdCreativeErirReconciliation,
  ordCreativeRegistrationForCreativeRevision, OrdCreativeRegistrationError,
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

describe("registerOrdCreative: creative-registration authority", () => {
  it("mints a DRAFT/MUTABLE registration pinned to the current provider profiles", () => {
    const { db, creativeRevisionId } = setup();
    const { registration, replayed } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(replayed).toBe(false);
    expect(registration.creative_revision_id).toBe(creativeRevisionId);
    expect(registration.local_state).toBe("DRAFT");
    expect(registration.lock_state).toBe("MUTABLE");
    expect(registration.erid).toBeNull();
  });

  it("is idempotent: a second call for the SAME creative revision (L6: engagement revision changed, content did not) returns the SAME registration/ERID", () => {
    const { db, creativeRevisionId } = setup();
    const first = registerOrdCreative(db, admin, creativeRevisionId);
    confirmOrdCreativeRegistration(db, first.registration.id, "vk-obj-1", "erid-1", "ev");
    const second = registerOrdCreative(db, admin, creativeRevisionId);
    expect(second.replayed).toBe(true);
    expect(second.registration.id).toBe(first.registration.id);
    expect(second.registration.erid).toBe("erid-1");
  });

  it("a changed creative_hash (new engagement_creative_revisions row) always requires a NEW registration - never reuses an ERID", () => {
    const { db, engagementId, creativeRevisionId, p1 } = setup();
    const first = registerOrdCreative(db, admin, creativeRevisionId);
    confirmOrdCreativeRegistration(db, first.registration.id, "vk-obj-1", "erid-1", "ev");
    const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const { creativeRevisionId: c2 } = readyCreative(db, engagementId, canonicalTargetUrl(p1.cityId, code), "story");
    expect(c2).not.toBe(creativeRevisionId);
    const second = registerOrdCreative(db, admin, c2);
    expect(second.replayed).toBe(false);
    expect(second.registration.id).not.toBe(first.registration.id);
    expect(second.registration.erid).toBeNull();
  });

  it("two concurrent registration attempts for the SAME creative revision: one loses structurally (UNIQUE(creative_revision_id))", () => {
    const { db, creativeRevisionId } = setup();
    registerOrdCreative(db, admin, creativeRevisionId);
    // Bypass the app-level idempotent read (simulating a genuine race) with a raw second INSERT naming the same creative revision.
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      SELECT ?, creative_revision_id, engagement_id, 'different-op-key', provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id
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
    expect(() => confirmOrdCreativeRegistration(db, registration.id, "vk-obj-1", "erid-1", "ev")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
  });
});

describe("recordOrdCreativeRegistrationSubmitted / confirmOrdCreativeRegistration / recordOrdCreativeErirReconciliation", () => {
  it("submitted -> confirmed -> locked: the full manual lifecycle", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    const submitted = recordOrdCreativeRegistrationSubmitted(db, registration.id, "vk-ext-1", "ev-submit");
    expect(submitted.vk_submission_state).toBe("SUBMITTED");
    expect(submitted.lock_state).toBe("MUTABLE");
    recordOrdCreativeErirReconciliation(db, registration.id, "erir-1");
    const confirmed = confirmOrdCreativeRegistration(db, registration.id, "vk-obj-1", "erid-1", "ev-confirm");
    expect(confirmed.lock_state).toBe("EXTERNALLY_LOCKED");
    expect(confirmed.erid).toBe("erid-1");
    expect(confirmed.erir_code).toBe("erir-1");
  });

  it("once EXTERNALLY_LOCKED, no further mutation of any kind is legal - not even re-recording the same erir_code", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    const locked = confirmOrdCreativeRegistration(db, registration.id, "vk-obj-1", "erid-1", "ev");
    expect(() => recordOrdCreativeErirReconciliation(db, locked.id, "erir-1")).toThrow(/AGENT_REFERRALS_ORD_CREATIVE_REGISTRATION_LOCKED/);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET evidence_ref = 'x' WHERE id = ?").run(locked.id)).toThrow(/ORD_CREATIVE_REGISTRATION_TERMINAL_IMMUTABLE/);
  });

  it("a provider-observed id, once set, can never be overwritten to a different value (raw SQL) - even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    recordOrdCreativeRegistrationSubmitted(db, registration.id, "vk-ext-1", "ev");
    expect(() => db.prepare("UPDATE ord_creative_registrations SET vk_external_id = 'vk-ext-REWRITTEN' WHERE id = ?").run(registration.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_OBSERVED_ID_IMMUTABLE/);
  });

  it("authority columns (creative_revision_id, engagement_id, operation_key, provider profile pins) are DB-immutable even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => db.prepare("UPDATE ord_creative_registrations SET operation_key = 'different' WHERE id = ?").run(registration.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_AUTHORITY_COLUMNS_IMMUTABLE/);
  });

  it("refuses a raw INSERT naming a registered_creative_target_url that disagrees with the creative's own creative_target_url", () => {
    const { db, creativeRevisionId, engagementId } = setup();
    const profiles = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'COUNTERPARTY'").get() as { id: string };
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_creative_registrations(id, creative_revision_id, engagement_id, operation_key, provider_counterparty_profile_id, provider_contract_profile_id, registered_creative_target_url, created_by_admin_id)
      VALUES (?, ?, ?, 'op-1', ?, ?, 'https://wrong-url.example', 'admin')`).run(randomUUID(), creativeRevisionId, engagementId, profiles.id, contract.id))
      .toThrow(/ORD_CREATIVE_REGISTRATION_RELATIONAL_INCONSISTENT/);
  });

  it("delete is never legal, even pre-lock", () => {
    const { db, creativeRevisionId } = setup();
    const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
    expect(() => db.prepare("DELETE FROM ord_creative_registrations WHERE id = ?").run(registration.id)).toThrow(/ORD_CREATIVE_REGISTRATION_IMMUTABLE/);
  });
});

describe("errors", () => {
  it("OrdCreativeRegistrationError carries a code and status", () => {
    const err = new OrdCreativeRegistrationError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });

  it("ordCreativeRegistrationForCreativeRevision returns null for an unregistered creative", () => {
    const { db, creativeRevisionId } = setup();
    expect(ordCreativeRegistrationForCreativeRevision(db, creativeRevisionId)).toBeNull();
  });
});
