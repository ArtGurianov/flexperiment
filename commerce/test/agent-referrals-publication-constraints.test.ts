import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { admin, fresh, nearTermTerms, offerAcceptActivate, purchaseAndPay, readyPartner, seedOccurrence } from "./support/agent-referrals-settlement-fixtures";
import type { CommerceDomain } from "../src/domain";
import { authorizeCreative, currentCreativeRevision, lastCreativeAuthorization, mintCreativeRevision } from "../src/agent-referrals-creative";
import { reportDistribution } from "../src/agent-referrals-distribution";
import { currentDelegationTemplateRevision, mintDelegationTemplateRevision, DELEGATION_TEMPLATE_REQUIRED_CLAUSES, type DelegationTemplateClauseKey } from "../src/agent-referrals-framework-delegation";

/**
 * Constraints of the live schema around what a partner was authorised to
 * publish, where they published it, and what the regulator was told.
 *
 * A promo authorization is the claim that a particular code, placed on a
 * particular occurrence, belongs to a particular engagement revision. An order
 * points at one, so rewriting it re-attributes purchases that already happened.
 */
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const query = <T>(db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as T;
const rowOf = (db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  query<Record<string, unknown>>(db, sql, ...args);

const insertVariant = (db: Database.Database, table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...source, ...changes, id: randomUUID() };
  const columns = Object.keys(next);
  return () => db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(next);
};

const engaged = (db: Database.Database) => {
  const partner = readyPartner(db, "NPD");
  const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  return { partner, occurrenceId, engagementId };
};

const setup = () => {
  const { db, domain } = fresh();
  open.push(db);
  return { db, domain: domain as CommerceDomain };
};

describe("an engagement revision is the agreement, and it does not change", () => {
  it("cannot be edited or erased", () => {
    // Orders, reward snapshots, acts and settlements all pin a revision.
    // Editing one rewrites the terms those were computed under.
    const { db } = setup();
    const { engagementId } = engaged(db);
    const revision = rowOf(db, "SELECT * FROM engagement_revisions WHERE engagement_id = ? LIMIT 1", engagementId);

    expect(() => db.prepare("UPDATE engagement_revisions SET reward_value = 1 WHERE id = ?").run(revision.id))
      .toThrow(/ENGAGEMENT_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM engagement_revisions WHERE id = ?").run(revision.id))
      .toThrow(/ENGAGEMENT_REVISION_IMMUTABLE/);
  });
});

describe("a promo authorization places one code on one occurrence", () => {
  it.each([
    "promo_code_id = 'elsewhere'",
    "partner_id = 'elsewhere'",
    "occurrence_id = 'elsewhere'",
    "engagement_id = 'elsewhere'",
    "engagement_revision_id = 'elsewhere'",
  ])("refuses to change %s", (assignment) => {
    // An order names the authorization it was attributed through. Moving the
    // authorization re-attributes purchases that already happened.
    const { db } = setup();
    const { engagementId } = engaged(db);
    const authorization = rowOf(db, "SELECT * FROM engagement_promo_authorizations WHERE engagement_id = ? LIMIT 1", engagementId);

    expect(() => db.prepare(`UPDATE engagement_promo_authorizations SET ${assignment} WHERE id = ?`).run(authorization.id))
      .toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_PLACEMENT_IMMUTABLE/);
  });

  it("cannot be deleted", () => {
    const { db } = setup();
    const { engagementId } = engaged(db);
    const authorization = rowOf(db, "SELECT * FROM engagement_promo_authorizations WHERE engagement_id = ? LIMIT 1", engagementId);

    expect(() => db.prepare("DELETE FROM engagement_promo_authorizations WHERE id = ?").run(authorization.id))
      .toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_IMMUTABLE/);
  });

  it("cannot be touched once revoked", () => {
    // Revocation is one-way. A revoked authorization that could be edited is
    // one that could be un-revoked.
    const { db } = setup();
    const { engagementId } = engaged(db);
    const authorization = rowOf(db, "SELECT * FROM engagement_promo_authorizations WHERE engagement_id = ? LIMIT 1", engagementId);
    db.prepare("UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(authorization.id);

    expect(() => db.prepare("UPDATE engagement_promo_authorizations SET revoked_at = NULL WHERE id = ?").run(authorization.id))
      .toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_ALREADY_REVOKED/);
  });
});

describe("a reported distribution revision is what the regulator was told", () => {
  it("cannot be edited or erased", () => {
    const { db } = setup();
    const partner = readyPartner(db, "NPD");
    const occurrenceId = seedOccurrence(db, partner.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, partner.partner, partner.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
    const creative = mintCreativeRevision(db, admin, engagementId, {
      format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click",
      mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/x?promo=ART",
    }, currentCreativeRevision(db, engagementId)?.id ?? null);
    authorizeCreative(db, admin, engagementId, creative.id, lastCreativeAuthorization(db, engagementId)?.id ?? null);
    reportDistribution(db, partner.partner, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel",
      distribution_resource_url: "https://t.me/art_channel/1", published_at: "2030-09-10T00:00:00.000Z",
      ended_at: null, evidence_ref: "ev-1",
    });
    const revision = rowOf(db, "SELECT * FROM engagement_distribution_revisions LIMIT 1");
    expect(revision).toBeTruthy();

    expect(() => db.prepare("UPDATE engagement_distribution_revisions SET evidence_ref = 'rewritten' WHERE id = ?").run(revision.id))
      .toThrow(/ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM engagement_distribution_revisions WHERE id = ?").run(revision.id))
      .toThrow(/ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE/);
  });
});

describe("an ORD reporting delegation belongs to the partner who granted it", () => {
  it("refuses a delegation citing another partner's acceptance", () => {
    const { db } = setup();
    const first = readyPartner(db, "NPD");
    const second = readyPartner(db, "NPD");
    const delegation = rowOf(db, "SELECT * FROM ord_reporting_delegations WHERE partner_identity_id = ? LIMIT 1", first.partnerIdentityId);
    const foreignAcceptance = query<{ id: string }>(db, "SELECT id FROM framework_acceptances WHERE partner_identity_id = ? LIMIT 1", second.partnerIdentityId);

    expect(insertVariant(db, "ord_reporting_delegations", delegation, { framework_acceptance_id: foreignAcceptance.id }))
      .toThrow(/ORD_REPORTING_DELEGATION_ACCEPTANCE_PARTNER_MISMATCH/);
  });

  it("refuses a delegation on a template the issuance did not carry", () => {
    // The delegation template is part of what the partner accepted. Reporting
    // to the regulator under a different one is reporting under terms nobody
    // agreed to.
    const { db } = setup();
    const first = readyPartner(db, "NPD");
    const second = readyPartner(db, "NPD");
    const delegation = rowOf(db, "SELECT * FROM ord_reporting_delegations WHERE partner_identity_id = ? LIMIT 1", first.partnerIdentityId);
    const foreign = rowOf(db, "SELECT * FROM ord_reporting_delegations WHERE partner_identity_id = ? LIMIT 1", second.partnerIdentityId);

    void foreign;
    // Both partners were issued the same template, so the mismatch is built
    // from a newer revision that exists but was not the one issued to them.
    const newer = mintDelegationTemplateRevision(
      db,
      Object.fromEntries(DELEGATION_TEMPLATE_REQUIRED_CLAUSES.map((key: DelegationTemplateClauseKey) => [key, `${key} v2`])) as Record<DelegationTemplateClauseKey, string>,
      currentDelegationTemplateRevision(db)?.id ?? null,
    );
    expect(newer.id).not.toEqual(delegation.delegation_template_revision_id);

    expect(insertVariant(db, "ord_reporting_delegations", delegation, { delegation_template_revision_id: newer.id }))
      .toThrow(/ORD_REPORTING_DELEGATION_TEMPLATE_ISSUANCE_MISMATCH/);
  });

  it("freezes the reporting period policy", () => {
    const { db } = setup();
    readyPartner(db, "NPD");
    const policy = rowOf(db, "SELECT * FROM ord_reporting_period_policy LIMIT 1");
    expect(policy).toBeTruthy();

    expect(() => db.prepare("UPDATE ord_reporting_period_policy SET reason = 'rewritten' WHERE id = ?").run(policy.id))
      .toThrow(/ORD_REPORTING_PERIOD_POLICY_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM ord_reporting_period_policy WHERE id = ?").run(policy.id))
      .toThrow(/ORD_REPORTING_PERIOD_POLICY_IMMUTABLE/);
  });
});

describe("every order carries a public reference", () => {
  it("refuses an order without one, and refuses to change it", () => {
    // It is the number a customer quotes. An order that has none cannot be
    // talked about, and one whose number moved is a different order to
    // everyone who wrote the old one down.
    const { db, domain } = setup();
    const { partner, occurrenceId } = engaged(db);
    const { code } = query<{ code: string }>(db, "SELECT code FROM promo_codes WHERE id = ?", partner.promo.promo_code_id);
    purchaseAndPay(db, domain, occurrenceId, code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
    const existing = rowOf(db, "SELECT * FROM orders LIMIT 1");
    expect(existing).toBeTruthy();

    expect(insertVariant(db, "orders", existing, { public_order_number: null }))
      .toThrow(/PUBLIC_ORDER_NUMBER_REQUIRED/);
    expect(insertVariant(db, "orders", existing, { public_order_number: "   " }))
      .toThrow(/PUBLIC_ORDER_NUMBER_REQUIRED/);
    expect(() => db.prepare("UPDATE orders SET public_order_number = 'FX-CHANGED' WHERE id = ?").run(existing.id))
      .toThrow(/PUBLIC_ORDER_NUMBER_IMMUTABLE/);
  });
});
