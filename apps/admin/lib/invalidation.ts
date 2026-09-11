import type { QueryKey } from "@tanstack/react-query";
import {
  cityKeys, dashboardKeys, emailAttentionKeys, incidentKeys,
  occurrenceKeys, orderKeys, refundKeys, settlementKeys, agentKeys, promoKeys, driftKeys,
  agentReferralsKeys,
} from "./query-keys";

export type AdminMutation =
  | "city.create" | "city.patch"
  | "occurrence.create" | "occurrence.patch" | "occurrence.cancel" | "occurrence.complete"
  | "order.refund" | "order.abandonReservation"
  | "email.acknowledge" | "incident.resolve" | "drift.resolve"
  | "settlement.paymentMade" | "settlement.documentsComplete"
  | "settlement.cancelBeforePayment" | "settlement.recovery"
  | "agent.create" | "agent.patch" | "promo.create" | "promo.patch"
  | "emergency-sales-pause" | "emergency-sales-reopen"
  // PR-C: agent-referrals admin commands. Grouped by cache CONSEQUENCE, not
  // one arm per route - the same idiom the settlement.* arms below already
  // use, since what this table decides is what goes stale, not which button
  // was pressed (the audit trail is the backend's job, not the cache's).
  | "agentReferrals.featureState"
  | "agentReferrals.partnerProvision" | "agentReferrals.partnerCommand"
  | "agentReferrals.engagementOffer" | "agentReferrals.engagementCommand"
  | "agentReferrals.channelPolicy";

export type MutationContext = {
  cityId?: string;
  occurrenceId?: string;
  orderId?: string;
  settlementId?: string;
  agentId?: string;
  promoId?: string;
  partnerIdentityId?: string;
  engagementId?: string;
  channelKey?: string;
};

/**
 * The single place that decides mutation -> cache consequence. No component
 * may call invalidateQueries directly — mutations declare intent here, this
 * map decides what goes stale. Every entry includes dashboardKeys.summary()
 * (A4: no mutation may leave a dashboard counter behind), and every entry
 * targets the narrowest sufficient prefix — lists()/leaf, never all() —
 * asserted by invalidation.test.ts so the request budget in lib/polling.ts
 * can't regress through over-broad invalidation.
 */
export function invalidationKeysFor(mutation: AdminMutation, ctx: MutationContext = {}): readonly QueryKey[] {
  switch (mutation) {
    case "city.create":
      return [cityKeys.lists(), dashboardKeys.summary()];
    case "city.patch":
      return [cityKeys.lists(), ...(ctx.cityId ? [cityKeys.detail(ctx.cityId)] : []), dashboardKeys.summary()];
    case "occurrence.create":
      return [occurrenceKeys.lists(), dashboardKeys.summary()];
    case "occurrence.patch":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.detail(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "occurrence.cancel":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.cancellationFinancials(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "occurrence.complete":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.detail(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "order.refund":
      return [orderKeys.lists(), ...(ctx.orderId ? [orderKeys.evidence(ctx.orderId)] : []), refundKeys.lists(), dashboardKeys.summary()];
    case "order.abandonReservation":
      return [orderKeys.lists(), ...(ctx.orderId ? [orderKeys.evidence(ctx.orderId)] : []), dashboardKeys.summary()];
    case "email.acknowledge":
      return [emailAttentionKeys.lists(), dashboardKeys.summary()];
    case "incident.resolve":
      return [incidentKeys.lists(), dashboardKeys.summary()];
    case "drift.resolve":
      return [driftKeys.lists(), incidentKeys.lists(), dashboardKeys.summary()];
    case "settlement.paymentMade":
    case "settlement.documentsComplete":
    case "settlement.cancelBeforePayment":
    case "settlement.recovery":
      return [settlementKeys.lists(), ...(ctx.settlementId ? [settlementKeys.detail(ctx.settlementId)] : []), dashboardKeys.summary()];
    case "agent.create":
    case "agent.patch":
      return [agentKeys.lists(), promoKeys.lists(), dashboardKeys.summary()];
    case "promo.create":
    case "promo.patch":
      return [promoKeys.lists(), agentKeys.lists(), dashboardKeys.summary()];
    case "emergency-sales-pause":
    case "emergency-sales-reopen":
      return [dashboardKeys.summary()];
    // Suspending or reactivating the whole feature changes what the review
    // queue is allowed to contain, so both go stale together.
    case "agentReferrals.featureState":
      return [agentReferralsKeys.featureState(), agentReferralsKeys.reviewQueue(), dashboardKeys.summary()];
    // Provisioning adds a partner to the list; there is no detail open for
    // an identity that did not exist a moment ago.
    case "agentReferrals.partnerProvision":
      return [agentReferralsKeys.partners(), dashboardKeys.summary()];
    // Every other partner-scoped command (verification, framework issuance,
    // activation, promo, audience, NPD, destruction, legal-profile
    // supersession, tax treatment) changes the open detail AND the
    // onboarding state the list column shows.
    case "agentReferrals.partnerCommand":
      return [
        ...(ctx.partnerIdentityId ? [agentReferralsKeys.partner(ctx.partnerIdentityId)] : []),
        agentReferralsKeys.partners(), agentReferralsKeys.reviewQueue(), dashboardKeys.summary(),
      ];
    case "agentReferrals.engagementOffer":
      return [
        ...(ctx.partnerIdentityId ? [agentReferralsKeys.engagements(ctx.partnerIdentityId)] : []),
        agentReferralsKeys.reviewQueue(), dashboardKeys.summary(),
      ];
    case "agentReferrals.engagementCommand":
      return [
        ...(ctx.engagementId ? [agentReferralsKeys.engagement(ctx.engagementId)] : []),
        ...(ctx.partnerIdentityId ? [agentReferralsKeys.engagements(ctx.partnerIdentityId)] : []),
        agentReferralsKeys.reviewQueue(), dashboardKeys.summary(),
      ];
    case "agentReferrals.channelPolicy":
      return [
        ...(ctx.channelKey ? [agentReferralsKeys.channelPolicy(ctx.channelKey)] : []),
        agentReferralsKeys.reviewQueue(), dashboardKeys.summary(),
      ];
  }
}

export const ALL_ADMIN_MUTATIONS: readonly AdminMutation[] = [
  "city.create", "city.patch",
  "occurrence.create", "occurrence.patch", "occurrence.cancel", "occurrence.complete",
  "order.refund", "order.abandonReservation",
  "email.acknowledge", "incident.resolve", "drift.resolve",
  "settlement.paymentMade", "settlement.documentsComplete",
  "settlement.cancelBeforePayment", "settlement.recovery",
  "agent.create", "agent.patch", "promo.create", "promo.patch",
  "emergency-sales-pause", "emergency-sales-reopen",
  "agentReferrals.featureState", "agentReferrals.partnerProvision", "agentReferrals.partnerCommand",
  "agentReferrals.engagementOffer", "agentReferrals.engagementCommand", "agentReferrals.channelPolicy",
];
