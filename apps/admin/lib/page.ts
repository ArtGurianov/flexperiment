export type Page =
  | "dashboard" | "login" | "cities" | "occurrences" | "orders" | "refunds"
  | "settlements" | "email-attention" | "incidents" | "audit" | "agents" | "promo-codes" | "agent-referrals"
  | "courses" | "lab" | "customers" | "access" | "integrations";

export type Row = Record<string, unknown>;
