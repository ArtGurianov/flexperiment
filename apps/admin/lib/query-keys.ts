import { normalizeIncidentFilters, normalizeOrderFilters, normalizeRefundFilters, normalizeSettlementFilters, type IncidentFilters, type OrderFilters, type RefundFilters, type SettlementFilters } from "./filters";

export const cityKeys = {
  all: () => ["cities"] as const,
  lists: () => ["cities", "list"] as const,
  list: () => ["cities", "list"] as const,
  detail: (id: string) => ["cities", "detail", id] as const,
};

export const occurrenceKeys = {
  all: () => ["occurrences"] as const,
  lists: () => ["occurrences", "list"] as const,
  list: (cityId?: string) => ["occurrences", "list", cityId || null] as const,
  detail: (id: string) => ["occurrences", "detail", id] as const,
  cancellationFinancials: (id: string) => ["occurrences", "cancellationFinancials", id] as const,
};

export const orderKeys = {
  all: () => ["orders"] as const,
  lists: () => ["orders", "list"] as const,
  list: (filters: OrderFilters) => ["orders", "list", normalizeOrderFilters(filters)] as const,
  evidence: (id: string) => ["orders", "evidence", id] as const,
  detail: (id: string) => ["orders", "detail", id] as const,
};

export const refundKeys = {
  all: () => ["refunds"] as const,
  lists: () => ["refunds", "list"] as const,
  list: (filters: RefundFilters = {}) => ["refunds", "list", normalizeRefundFilters(filters)] as const,
  detail: (id: string) => ["refunds", "detail", id] as const,
};

export const settlementKeys = {
  all: () => ["settlements"] as const,
  lists: () => ["settlements", "list"] as const,
  list: (filters: SettlementFilters = {}) => ["settlements", "list", normalizeSettlementFilters(filters)] as const,
  detail: (id: string) => ["settlements", "detail", id] as const,
};

export const emailAttentionKeys = {
  all: () => ["email-attention"] as const,
  lists: () => ["email-attention", "list"] as const,
  list: () => ["email-attention", "list"] as const,
};

export const incidentKeys = {
  all: () => ["operational-incidents"] as const,
  lists: () => ["operational-incidents", "list"] as const,
  list: (filters: IncidentFilters = {}) => ["operational-incidents", "list", normalizeIncidentFilters(filters)] as const,
};

export const driftKeys = {
  all: () => ["provider-drift-reviews"] as const,
  lists: () => ["provider-drift-reviews", "list"] as const,
  list: () => ["provider-drift-reviews", "list"] as const,
};

export const auditKeys = {
  all: () => ["audit"] as const,
  lists: () => ["audit", "list"] as const,
  list: () => ["audit", "list"] as const,
};

export const agentKeys = {
  all: () => ["agents"] as const,
  lists: () => ["agents", "list"] as const,
  list: () => ["agents", "list"] as const,
  balance: (agentId: string, occurrenceId: string) => ["agents", "balance", agentId, occurrenceId] as const,
};

export const promoKeys = {
  all: () => ["promo-codes"] as const,
  lists: () => ["promo-codes", "list"] as const,
  list: () => ["promo-codes", "list"] as const,
  detail: (id: string) => ["promo-codes", "detail", id] as const,
};

export const dashboardKeys = {
  all: () => ["dashboard"] as const,
  summary: () => ["dashboard", "summary"] as const,
};

/**
 * PR-C: the agent-referrals admin surfaces used to spell their keys inline
 * at every call site, which is also why their invalidation was written by
 * hand per component. Same taxonomy rule as every other resource here: a
 * list key and a detail key never share a prefix, so refreshing a list
 * cannot nuke an open detail panel.
 */
export const agentReferralsKeys = {
  all: () => ["agent-referrals"] as const,
  featureState: () => ["agent-referrals", "feature-state"] as const,
  reviewQueue: () => ["agent-referrals", "review-queue"] as const,
  partners: () => ["agent-referrals", "partners"] as const,
  partner: (partnerIdentityId: string) => ["agent-referrals", "partner", partnerIdentityId] as const,
  /** The list FAMILY. A command cannot know which partner filter the operator currently has typed in, so it invalidates the family and every filtered list under it re-reads. Detail keys live under the singular "engagement" segment, so this prefix never reaches them. */
  engagementLists: () => ["agent-referrals", "engagements"] as const,
  engagements: (partnerIdentityId: string) => ["agent-referrals", "engagements", partnerIdentityId] as const,
  engagement: (engagementId: string) => ["agent-referrals", "engagement", engagementId] as const,
  creativeRegistrations: (creativeRevisionId: string) => ["agent-referrals", "creative-registrations", creativeRevisionId] as const,
  channelPolicy: (channelKey: string) => ["agent-referrals", "channel-policy", channelKey] as const,
};

/**
 * PARTNER realm keys. Deliberately a separate taxonomy from every key above:
 * realm separation is a hard boundary in this system (see 0044's own comment
 * on the partner audit trail), and an admin-realm invalidation must never be
 * able to reach into partner-realm cache, or vice versa, by sharing a prefix.
 */
export const partnerKeys = {
  all: () => ["partner"] as const,
  me: () => ["partner", "me"] as const,
  agreements: () => ["partner", "agreements"] as const,
  payoutProfile: () => ["partner", "payout-profile"] as const,
  engagements: () => ["partner", "engagements"] as const,
  engagement: (engagementId: string) => ["partner", "engagement", engagementId] as const,
  /**
   * A SIBLING of engagement(), not a child. TanStack matches invalidation by
   * key prefix, so ["partner","engagement",id,"conversions"] would be swept
   * up by every engagement invalidation - which is exactly what the table
   * claims it does not do. Conversions follow real orders; no partner
   * command moves them, and refetching them on every act acceptance is
   * request budget spent on an answer that cannot have changed.
   */
  conversions: (engagementId: string) => ["partner", "conversions", engagementId] as const,
};
