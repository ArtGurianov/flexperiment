import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { mintCreativeRevision, authorizeCreative, type CreativeFormatKind } from "../../src/agent-referrals-creative";
import { reportDistribution } from "../../src/agent-referrals-distribution";
import { mintOrdProviderProfile } from "../../src/agent-referrals-ord-provider-profile";
import { registerOrdCreative, recordOrdCreativeRegistrationSubmitted, confirmOrdCreativeRegistration } from "../../src/agent-referrals-ord-creative-registration";
import { admin, type PartnerPrincipal } from "./agent-referrals-settlement-fixtures";

/**
 * PR8-specific fixture helpers layered on top of the PR7 shared chain
 * (readyPartner/seedOccurrence/offerAcceptActivate/...) in
 * agent-referrals-settlement-fixtures.ts - creative content + authorization,
 * provider profile seeding, a fully LOCKED (ERID-bearing) creative
 * registration, and an actual reported distribution.
 */

export const seedOrdProviderProfiles = (db: Database.Database) => {
  const counterparty = mintOrdProviderProfile(db, admin.admin_id, "COUNTERPARTY", { legal_name: "Flexperiment LLC", inn: "7700000000" }, "seed");
  const contract = mintOrdProviderProfile(db, admin.admin_id, "CONTRACT", { contract_ref: "VK-ORD-2026-1" }, "seed");
  const platform = mintOrdProviderProfile(db, admin.admin_id, "PLATFORM", { platform: "flexperiment.ru" }, "seed");
  const media = mintOrdProviderProfile(db, admin.admin_id, "MEDIA", { media_ref: "flexperiment-site" }, "seed");
  return { counterparty, contract, platform, media };
};

export const canonicalTargetUrl = (citySlug: string, promoCode: string) => `https://flexperiment.ru/${citySlug}?promo=${promoCode}`;

export type ReadyCreative = { engagementId: string; creativeRevisionId: string };

/** Mints a creative revision under the given format and authorizes it for the (already ACTIVE) engagement. */
export const readyCreative = (
  db: Database.Database,
  engagementId: string,
  targetUrl: string,
  formatKind: CreativeFormatKind = "post",
): ReadyCreative => {
  const creative = mintCreativeRevision(db, admin, engagementId, {
    format_kind: formatKind, media_ref: null, copy_text: "Buy now", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: targetUrl,
  });
  authorizeCreative(db, admin, engagementId, creative.id);
  return { engagementId, creativeRevisionId: creative.id };
};

/** Registers, submits, AND confirms (ERID-bearing, CORRECTION_ONLY) a creative revision's ORD registration - the state CREATIVE_READY_TO_PUBLISH's provider half requires. */
export const confirmedRegistration = (db: Database.Database, creativeRevisionId: string) => {
  const { registration } = registerOrdCreative(db, admin, creativeRevisionId);
  recordOrdCreativeRegistrationSubmitted(db, registration.id, `vk-ext-${randomUUID().slice(0, 8)}`, "manual VK submission");
  return confirmOrdCreativeRegistration(db, registration.id, `vk-obj-${randomUUID().slice(0, 8)}`, `erid-${randomUUID().slice(0, 8)}`, "manual VK confirmation");
};

/** Reports one real, ALLOWED-channel, in-window distribution for the engagement's current creative authorization, publishedAt inside the given date. */
export const reportedDistribution = (db: Database.Database, partner: PartnerPrincipal, engagementId: string, publishedAt: string, channelKey = "telegram") =>
  reportDistribution(db, partner, engagementId, {
    channel_key: channelKey, resource_kind: "channel", resource_identifier: "@example_channel", distribution_resource_url: "https://t.me/example_channel/1",
    published_at: publishedAt, ended_at: null, evidence_ref: "ev-distribution-1",
  });
