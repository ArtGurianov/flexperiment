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

export const salesControlKeys = {
  all: () => ["sales-control"] as const,
  summary: () => ["sales-control", "summary"] as const,
};
