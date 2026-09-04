import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement, acceptedAct,
} from "./support/agent-referrals-settlement-fixtures";
import { seedOrdProviderProfiles } from "./support/agent-referrals-ord-fixtures";
import { generateSettlementAct, presentSettlementAct } from "../src/agent-referrals-act";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { setPartnerPayoutDestination, currentPayoutProfile } from "../src/agent-referrals-payout-profile";
import { mintOrdPaidInvoicePayload, recordOrdPaidInvoiceReconciliation, ordPaidInvoicePayloadForAct, OrdPaidInvoiceError } from "../src/agent-referrals-ord-paid-invoice";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const readyAcceptedAct = () => {
  const { db, domain } = fresh();
  open.push(db);
  seedOrdProviderProfiles(db);
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
  const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occ, code, "invoice-test@example.test", "idem-invoice-test-1");
  const settlement = finalizedSettlement(db, domain, occ, engagementId);
  const act = acceptedAct(db, p1.partner, settlement);
  return { db, p1, engagementId, settlement, act };
};

describe("mintOrdPaidInvoicePayload: VKPaidInvoicePayload", () => {
  it("mints a payload deriving every field from the accepted act's own frozen authority", () => {
    const { db, act, settlement, p1 } = readyAcceptedAct();
    const { payload, replayed } = mintOrdPaidInvoicePayload(db, admin, act.id);
    expect(replayed).toBe(false);
    expect(payload.act_id).toBe(act.id);
    expect(payload.settlement_id).toBe(settlement.id);
    expect(payload.partner_identity_id).toBe(p1.partnerIdentityId);
    expect(payload.accepted_amount_kopecks).toBe(act.amount_kopecks);
    expect(payload.tax_mode_snapshot).toBe(settlement.tax_mode_snapshot);
    expect(payload.legal_profile_revision_id_snapshot).toBe(settlement.legal_profile_revision_id_snapshot);
  });

  it("is idempotent by act_id - a second call returns the SAME payload, never a divergent second one", () => {
    const { db, act } = readyAcceptedAct();
    const first = mintOrdPaidInvoicePayload(db, admin, act.id);
    const second = mintOrdPaidInvoicePayload(db, admin, act.id);
    expect(second.replayed).toBe(true);
    expect(second.payload.id).toBe(first.payload.id);
    expect(second.payload.canonical_hash).toBe(first.payload.canonical_hash);
  });

  it("refuses an act with no genuine acceptance yet", () => {
    const { db, domain } = fresh(); open.push(db);
    seedOrdProviderProfiles(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code, "x@example.test", "idem-notaccepted-1");
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id); // presented, but never accepted
    expect(() => mintOrdPaidInvoicePayload(db, admin, act.id)).toThrow(/AGENT_REFERRALS_ORD_PAID_INVOICE_ACT_NOT_ACCEPTED/);
  });

  it("the payload is byte-identical (same canonical_hash) even after the partner's payout profile later changes to a new revision", () => {
    const { db, act, p1 } = readyAcceptedAct();
    const before = mintOrdPaidInvoicePayload(db, admin, act.id).payload;
    const beforePayout = currentPayoutProfile(db, p1.partnerIdentityId)!;

    // A new payout-profile revision after acceptance - the mutable "current" fact the payload must never wrongly re-read live.
    const grant = mintStepUpGrant(db, p1.partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: beforePayout.id });
    setPartnerPayoutDestination(db, p1.partner, { step_up_grant_id: grant.grant_id, destination_kind: "BANK_ACCOUNT", destination_plaintext: "40817810099910004312", destination_last4: "4312" });
    expect(currentPayoutProfile(db, p1.partnerIdentityId)!.revision).toBeGreaterThan(beforePayout.revision);

    const after = mintOrdPaidInvoicePayload(db, admin, act.id).payload; // idempotent replay of the SAME payload
    expect(after.canonical_hash).toBe(before.canonical_hash);
    expect(after.legal_profile_revision_id_snapshot).toBe(before.legal_profile_revision_id_snapshot);
  });

  it("no caller-supplied amount is ever accepted - the mint signature takes no amount parameter at all", () => {
    expect(mintOrdPaidInvoicePayload.length).toBeLessThanOrEqual(4); // (db, admin, actId, providerContractProfileId?)
  });
});

describe("recordOrdPaidInvoiceReconciliation", () => {
  it("records submission + erir evidence and locks the payload", () => {
    const { db, act } = readyAcceptedAct();
    const { payload } = mintOrdPaidInvoicePayload(db, admin, act.id);
    const locked = recordOrdPaidInvoiceReconciliation(db, payload.id, "vk-op-1", "erir-1");
    expect(locked.lock_state).toBe("EXTERNALLY_LOCKED");
    expect(locked.erir_code).toBe("erir-1");
  });

  it("once locked, no further mutation of any kind is legal", () => {
    const { db, act } = readyAcceptedAct();
    const { payload } = mintOrdPaidInvoicePayload(db, admin, act.id);
    recordOrdPaidInvoiceReconciliation(db, payload.id, "vk-op-1", "erir-1");
    expect(() => recordOrdPaidInvoiceReconciliation(db, payload.id, "vk-op-2", "erir-2")).toThrow(/AGENT_REFERRALS_ORD_PAID_INVOICE_PAYLOAD_LOCKED/);
    expect(() => db.prepare("UPDATE ord_paid_invoice_payloads SET erir_code = 'x' WHERE id = ?").run(payload.id)).toThrow(/ORD_PAID_INVOICE_PAYLOAD_TERMINAL_IMMUTABLE/);
  });
});

describe("cross-authority structural backstops (raw SQL)", () => {
  it("refuses a payload naming an accepted_amount_kopecks that disagrees with the act's own acceptance", () => {
    const { db, act, settlement, p1 } = readyAcceptedAct();
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_paid_invoice_payloads(id, act_id, settlement_id, engagement_id, partner_identity_id, accepted_amount_kopecks, accepted_engagement_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot, contractor_type_snapshot, provider_contract_profile_id, operation_key, canonical_hash, created_by_admin_id)
      VALUES ('fabricated-payload', ?, ?, ?, ?, 1, ?, ?, ?, 'SELF_EMPLOYED', ?, 'op-1', 'h', 'admin')`)
      .run(act.id, settlement.id, act.engagement_id, p1.partnerIdentityId, act.engagement_revision_id, settlement.tax_mode_snapshot, settlement.legal_profile_revision_id_snapshot, contract.id))
      .toThrow(/ORD_PAID_INVOICE_PAYLOAD_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a payload naming a wrong act/settlement pairing", () => {
    const { db, act, p1 } = readyAcceptedAct();
    const contract = db.prepare("SELECT id FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { id: string };
    const acceptance = db.prepare("SELECT accepted_amount_kopecks, accepted_engagement_revision_id FROM settlement_act_acceptances WHERE act_id = ?").get(act.id) as { accepted_amount_kopecks: number; accepted_engagement_revision_id: string };
    expect(() => db.prepare(`INSERT INTO ord_paid_invoice_payloads(id, act_id, settlement_id, engagement_id, partner_identity_id, accepted_amount_kopecks, accepted_engagement_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot, contractor_type_snapshot, provider_contract_profile_id, operation_key, canonical_hash, created_by_admin_id)
      VALUES ('fabricated-payload-2', ?, 'wrong-settlement-id', ?, ?, ?, ?, 'OTHER', 'x', 'SELF_EMPLOYED', ?, 'op-2', 'h', 'admin')`)
      .run(act.id, act.engagement_id, p1.partnerIdentityId, acceptance.accepted_amount_kopecks, acceptance.accepted_engagement_revision_id, contract.id))
      .toThrow();
  });

  it("delete is never legal, even pre-lock", () => {
    const { db, act } = readyAcceptedAct();
    const { payload } = mintOrdPaidInvoicePayload(db, admin, act.id);
    expect(() => db.prepare("DELETE FROM ord_paid_invoice_payloads WHERE id = ?").run(payload.id)).toThrow(/ORD_PAID_INVOICE_PAYLOAD_IMMUTABLE/);
  });
});

describe("errors", () => {
  it("OrdPaidInvoiceError carries a code and status", () => {
    const err = new OrdPaidInvoiceError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });

  it("ordPaidInvoicePayloadForAct returns null when no payload exists", () => {
    const { db, act } = readyAcceptedAct();
    expect(ordPaidInvoicePayloadForAct(db, act.id)).toBeNull();
  });
});
