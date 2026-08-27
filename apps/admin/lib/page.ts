export type Page =
  | "dashboard" | "login" | "cities" | "occurrences" | "orders" | "refunds"
  | "settlements" | "email-attention" | "incidents" | "audit" | "agents" | "promo-codes";

export type Row = Record<string, unknown>;
