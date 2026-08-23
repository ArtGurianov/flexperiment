import { z } from "zod";
import { CITY_SLUGS } from "../../lib/city-catalog";

export { CITY_SLUGS } from "../../lib/city-catalog";
export type CitySlug = (typeof CITY_SLUGS)[number];

export const checkoutRequestSchema = z.object({
  quote_id: z.string().uuid(),
  customer_name: z.string().trim().min(2).max(160),
  customer_email: z.string().trim().email().max(320),
  eligibility_confirmed: z.literal(true),
  offer_accepted: z.literal(true),
  pd_consent_accepted: z.literal(true),
});

export const checkoutContextSchema = z.object({
  occurrence_id: z.string().uuid(),
  promo_code: z.string().trim().max(64).optional(),
  referral_slug: z.string().trim().max(100).optional(),
});

export const customerCancellationSchema = z.object({
  reason: z.string().trim().min(3).max(1_000),
  confirmation_text: z.string().trim(),
  withheld_expense_amount_kopecks: z.number().int().nonnegative().optional(),
  expense_justification: z.string().trim().min(3).max(1_000).optional(),
  evidence_reference: z.string().trim().min(3).max(1_000).optional(),
}).superRefine((input, ctx) => {
  const withheld = input.withheld_expense_amount_kopecks ?? 0;
  if (withheld > 0 && (!input.expense_justification || !input.evidence_reference)) {
    ctx.addIssue({ code: "custom", message: "Expense justification and evidence are required for a withholding." });
  }
});

export const compensationRefundSchema = z.object({
  amount_kopecks: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1_000),
  note: z.string().trim().max(2_000).optional(),
}).strict();

export const occurrencePatchSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  venue_status: z.enum(["CONFIRMED", "TO_BE_ANNOUNCED"]).optional(),
  venue_name: z.string().trim().min(1).max(300).nullable().optional(),
  venue_address: z.string().trim().min(1).max(1_000).nullable().optional(),
  venue_public: z.boolean().optional(),
  venue_disclosure_text: z.string().trim().min(1).max(2_000).nullable().optional(),
  venue_announce_by: z.string().datetime().nullable().optional(),
  price_kopecks: z.number().int().nonnegative().optional(),
  capacity: z.number().int().nonnegative().optional(),
  sales_status: z.enum(["OPEN", "PAUSED", "CLOSED"]).optional(),
  visibility: z.enum(["HIDDEN", "PUBLISHED"]).optional(),
  reason: z.string().trim().min(3).max(1_000),
});

export const cityCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().regex(/^[a-z0-9-]{2,100}$/),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

export const occurrenceCreateSchema = z.object({
  city_id: z.string().uuid(),
  title: z.string().trim().min(2).max(300),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(100),
  price_kopecks: z.number().int().positive(),
  capacity: z.number().int().positive(),
  venue_status: z.enum(["CONFIRMED", "TO_BE_ANNOUNCED"]),
  venue_name: z.string().trim().min(1).max(300).nullable().optional(),
  venue_address: z.string().trim().min(1).max(1_000).nullable().optional(),
  venue_disclosure_text: z.string().trim().min(1).max(2_000).nullable().optional(),
  venue_announce_by: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(3).max(1_000),
}).strict().superRefine((input, ctx) => {
  if (Date.parse(input.ends_at) <= Date.parse(input.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "ends_at must be after starts_at." });
  }
  if (input.venue_status === "CONFIRMED" && (!input.venue_name || !input.venue_address)) {
    ctx.addIssue({ code: "custom", message: "Confirmed venues require name and address." });
  }
  if (input.venue_status === "TO_BE_ANNOUNCED" && (!input.venue_disclosure_text || !input.venue_announce_by)) {
    ctx.addIssue({ code: "custom", message: "Unannounced venues require disclosure text and announcement deadline." });
  }
  if (input.venue_status === "TO_BE_ANNOUNCED" && input.venue_announce_by && Date.parse(input.venue_announce_by) >= Date.parse(input.starts_at)) {
    ctx.addIssue({ code: "custom", path: ["venue_announce_by"], message: "venue_announce_by must be earlier than starts_at." });
  }
});

export const occurrenceCancelSchema = z.object({
  reason: z.string().trim().min(3).max(1_000),
  reauth_capability: z.string().min(32).max(256),
}).strict();
export const adminReauthSchema = z.object({
  password: z.string().min(1).max(1_000),
  purpose: z.literal("CANCEL_OCCURRENCE"),
  resource_id: z.string().uuid(),
}).strict();
export const customerRefundRequestSchema = z.object({
  order_number: z.string().trim().min(4).max(64).transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "")),
  captcha_token: z.string().trim().min(1).max(4_096),
}).strict();
export const cityInterestSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  city: z.enum(CITY_SLUGS),
  pd_consent_accepted: z.literal(true),
  captcha_token: z.string().trim().min(1).max(4_096),
}).strict();
export const customerRefundTokenSchema = z.object({
  token: z.string().min(32).max(256),
}).strict();
export const reservationAbandonSchema = z.object({ reason: z.string().trim().min(3).max(1_000) }).strict();
export const occurrenceCompleteSchema = z.object({ confirmation_text: z.string().trim() });

export const agentSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]{2,100}$/),
  display_name: z.string().trim().min(2).max(200),
  legal_name: z.string().trim().min(2).max(300),
  email: z.string().trim().email().max(320),
  contractor_type: z.enum(["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR"]),
  inn: z.string().trim().regex(/^\d{10,12}$/),
  contract_reference: z.string().trim().min(2).max(500),
  enabled: z.boolean().default(true),
  default_reward_type: z.enum(["PERCENT", "FIXED"]),
  default_reward_value: z.number().int().nonnegative(),
});
export const agentPatchSchema = agentSchema.partial().omit({ slug: true }).extend({
  npd_status_checked_at: z.string().datetime().nullable().optional(),
});

const promoSchemaBase = z.object({
  agent_id: z.string().uuid().nullable().optional(),
  code: z.string().trim().min(2).max(64),
  status: z.enum(["ACTIVE", "DISABLED"]).default("ACTIVE"),
  discount_type: z.enum(["NONE", "PERCENT", "FIXED"]),
  discount_value: z.number().int().nonnegative(),
});
export const promoSchema = promoSchemaBase.superRefine((input, ctx) => {
  if (input.discount_type === "PERCENT" && input.discount_value > 10_000) ctx.addIssue({ code: "custom", message: "Percent discount cannot exceed 100%." });
  if (input.discount_type === "NONE" && input.discount_value !== 0) ctx.addIssue({ code: "custom", message: "NONE discount requires value zero." });
});
export const promoPatchSchema = promoSchemaBase.partial().omit({ code: true }).superRefine((input, ctx) => {
  if (input.discount_type === "PERCENT" && (input.discount_value ?? 0) > 10_000) ctx.addIssue({ code: "custom", message: "Percent discount cannot exceed 100%." });
  if (input.discount_type === "NONE" && input.discount_value !== undefined && input.discount_value !== 0) ctx.addIssue({ code: "custom", message: "NONE discount requires value zero." });
});

export const settlementPrepareSchema = z.object({
  agent_id: z.string().uuid(),
  occurrence_id: z.string().uuid(),
  amount_kopecks: z.number().int().positive(),
  method: z.enum(["CASH", "TRANSFER"]),
});
export const settlementPaymentMadeSchema = z.object({ confirmation_text: z.literal("I confirm the money was transferred") });
export const settlementDocumentSchema = z.object({ document_reference: z.string().trim().min(2).max(1_000), npd_status_effective_on: z.string().date().optional() });
export const settlementCancelSchema = z.object({ confirmation_text: z.string().trim(), reason: z.string().trim().min(3).max(1_000) });
export const settlementRecoverySchema = z.object({ amount_recovered_kopecks: z.number().int().positive(), recovered_at: z.string().datetime(), method: z.enum(["CASH", "TRANSFER"]), evidence_reference: z.string().trim().min(3).max(1_000), note: z.string().trim().max(2_000).optional() });

export const providerReferenceSchema = z.object({ provider_reference: z.string().trim().min(2).max(500), observed_operation: z.string().trim().min(2).max(2_000), amount_kopecks: z.number().int().nonnegative(), currency: z.literal("RUB"), note: z.string().trim().min(3).max(2_000) });

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
