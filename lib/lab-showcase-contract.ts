import { z } from "zod";

const timezone = z.string().refine((value) => {
  try { new Intl.DateTimeFormat("ru-RU", { timeZone: value }); return true; }
  catch { return false; }
});

/**
 * FLEX-8 public LAB showcase: published events with dates and prices, readable while sales are
 * closed. It is information only, never a checkout grant, seat count or ticket capability.
 */
export const labShowcaseSchema = z.object({
  schema: z.literal("flexperiment.lab-showcase/1"),
  sales: z.object({
    state: z.enum(["OPEN", "CLOSED"]),
    /** Why sales are closed; a public, non-diagnostic reason. */
    reason: z.enum(["PAYMENTS_DISABLED", "STOREFRONT_CLOSED", "OFFERS_CLOSED"]).nullable(),
  }),
  interest: z.object({
    available: z.boolean(),
    consent: z.object({ version: z.string(), text: z.string(), textSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  }),
  cities: z.array(z.object({ cityId: z.string(), slug: z.string(), title: z.string() })),
  occurrences: z.array(z.object({
    occurrenceRef: z.string(), cityId: z.string(), title: z.string(),
    startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }), timezone,
    amountKopecks: z.number().int().nonnegative(), currency: z.literal("RUB"),
    venue: z.discriminatedUnion("status", [
      z.object({ status: z.literal("CONFIRMED"), name: z.string().nullable(), address: z.string().nullable() }),
      z.object({ status: z.literal("TO_BE_ANNOUNCED"), disclosureText: z.string(), announceBy: z.iso.datetime({ offset: true }) }),
    ]),
    /** OPEN only when the offer is PUBLIC and LAB sales are open; otherwise the event is information only. */
    sales: z.enum(["OPEN", "CLOSED"]),
  })),
});
export type LabShowcase = z.infer<typeof labShowcaseSchema>;

export const labInterestAcknowledgementSchema = z.object({ accepted: z.literal(true) });
