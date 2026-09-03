import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { generateSettlementAct, presentSettlementAct, acceptSettlementAct, disputeSettlementAct, settlementActById, actAcceptanceForAct, actDisputeForAct, SettlementActError } from "../src/agent-referrals-act";
import { mintSettlementStepUpGrant } from "../src/agent-referrals-settlement-step-up";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement,
} from "./support/agent-referrals-settlement-fixtures";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const track = (db: Database.Database) => { open.push(db); return db; };

const preparedSettlement = (db: Database.Database, domain: import("../src/domain").CommerceDomain) => {
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occ, code.code, `${Math.random()}@example.test`, `idem-${Math.random()}`);
  const settlement = finalizedSettlement(db, domain, occ, engagementId);
  return { p1, settlement };
};

const otherPartner = (db: Database.Database, domain: import("../src/domain").CommerceDomain) => {
  const p2 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p2.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p2.partner, p2.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p2.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occ, code.code, `${Math.random()}@example.test`, `idem-${Math.random()}`);
  finalizedSettlement(db, domain, occ, engagementId);
  return p2;
};

describe("act lifecycle: ACT_PREPARED -> ACT_PRESENTED -> ACT_ACCEPTED | DOCUMENT_DISPUTED", () => {
  it("generateSettlementAct is idempotent: at most one act per settlement, ever", () => {
    const { db, domain } = fresh(); track(db);
    const { settlement } = preparedSettlement(db, domain);
    const first = generateSettlementAct(db, admin, settlement.id);
    expect(first.replayed).toBe(false);
    const second = generateSettlementAct(db, admin, settlement.id);
    expect(second.replayed).toBe(true);
    expect(second.act.id).toBe(first.act.id);
  });

  it("presentSettlementAct is one-way and idempotent", () => {
    const { db, domain } = fresh(); track(db);
    const { settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    expect(act.presented_at).toBeNull();
    const first = presentSettlementAct(db, admin, act.id);
    expect(first.replayed).toBe(false);
    expect(first.act.presented_at).not.toBeNull();
    const second = presentSettlementAct(db, admin, act.id);
    expect(second.replayed).toBe(true);
    expect(second.act.presented_at).toBe(first.act.presented_at);
  });

  it("acceptSettlementAct requires the act to be presented first", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    const grant = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
    expect(() => acceptSettlementAct(db, p1.partner, act.id, grant.grant_id)).toThrow(/AGENT_REFERRALS_SETTLEMENT_ACT_NOT_PRESENTED/);
  });

  it("acceptSettlementAct succeeds once presented, pinning the exact act/amount/revision, and is idempotent", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    const grant = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
    const first = acceptSettlementAct(db, p1.partner, act.id, grant.grant_id);
    expect(first.replayed).toBe(false);
    expect(first.acceptance).toMatchObject({ act_id: act.id, accepted_amount_kopecks: act.amount_kopecks, accepted_engagement_revision_id: act.engagement_revision_id });
    const second = acceptSettlementAct(db, p1.partner, act.id, grant.grant_id);
    expect(second.replayed).toBe(true);
    expect(actAcceptanceForAct(db, act.id)!.id).toBe(first.acceptance.id);
  });

  it("admin cannot accept an act - acceptSettlementAct only ever accepts a PartnerPrincipal (type-enforced), never an AdminPrincipal", () => {
    const { db, domain } = fresh(); track(db);
    const { settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    // @ts-expect-error - admin is not a PartnerPrincipal; this line exists to prove the type system itself refuses the call, not merely a runtime check.
    expect(() => acceptSettlementAct(db, admin, act.id, "any-grant")).toThrow();
  });

  it("partner B cannot accept partner A's act, even holding their own genuinely-issued grant", () => {
    const { db, domain } = fresh(); track(db);
    const { settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    const p2 = otherPartner(db, domain);
    const grant = mintSettlementStepUpGrant(db, p2.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
    expect(() => acceptSettlementAct(db, p2.partner, act.id, grant.grant_id)).toThrow(/AGENT_REFERRALS_SETTLEMENT_ACT_WRONG_PARTNER/);
  });

  it("partner B cannot dispute partner A's act", () => {
    const { db, domain } = fresh(); track(db);
    const { settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    const p2 = otherPartner(db, domain);
    expect(() => disputeSettlementAct(db, p2.partner, act.id, "OTHER")).toThrow(/AGENT_REFERRALS_SETTLEMENT_ACT_WRONG_PARTNER/);
  });

  it("a step-up grant minted for act X cannot accept act Y, even for the same partner", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, settlement: settlement1 } = preparedSettlement(db, domain);
    const { act: act1 } = generateSettlementAct(db, admin, settlement1.id);
    presentSettlementAct(db, admin, act1.id);
    const grantForAct1 = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act1.id, amount_kopecks: act1.amount_kopecks, engagement_revision_id: act1.engagement_revision_id });

    // A second engagement for the same partner produces act2.
    const occ2 = seedOccurrence(db, p1.cityId, 50_000);
    const engagement2 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ2, nearTermTerms(1000, "PERCENT", 5000));
    const code2 = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ2, code2.code, "act2@example.test", "idem-act2-0000001");
    const settlement2 = finalizedSettlement(db, domain, occ2, engagement2);
    const { act: act2 } = generateSettlementAct(db, admin, settlement2.id);
    presentSettlementAct(db, admin, act2.id);

    expect(() => acceptSettlementAct(db, p1.partner, act2.id, grantForAct1.grant_id)).toThrow(/AGENT_REFERRALS_SETTLEMENT_STEP_UP_GRANT_INVALID/);
  });

  it("disputeSettlementAct blocks a later acceptance for the same act", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    disputeSettlementAct(db, p1.partner, act.id, "AMOUNT_INCORRECT", "wrong amount");
    const grant = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
    expect(() => acceptSettlementAct(db, p1.partner, act.id, grant.grant_id)).toThrow(/SETTLEMENT_ACT_ACCEPTANCE_INVALID/);
    expect(actDisputeForAct(db, act.id)).not.toBeNull();
  });

  it("disputeSettlementAct is idempotent", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, settlement } = preparedSettlement(db, domain);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    presentSettlementAct(db, admin, act.id);
    const first = disputeSettlementAct(db, p1.partner, act.id, "OTHER");
    expect(first.replayed).toBe(false);
    const second = disputeSettlementAct(db, p1.partner, act.id, "OTHER");
    expect(second.replayed).toBe(true);
    expect(second.dispute.id).toBe(first.dispute.id);
  });

  it("SettlementActError surfaces AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND for an unknown act", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = otherPartner(db, domain);
    try {
      acceptSettlementAct(db, p1.partner, "no-such-act", "no-such-grant");
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SettlementActError);
      expect((error as SettlementActError).code).toBe("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND");
    }
  });

  it("settlementActById returns null for an unknown id", () => {
    const { db } = fresh(); track(db);
    expect(settlementActById(db, "no-such-act")).toBeNull();
  });
});
