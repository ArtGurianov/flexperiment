import { z } from "zod";

/** Public LAB read model, not a checkout grant or a legacy ticket capability. */
export const labCatalogueSchema = z.object({
  schema: z.literal("flexperiment.lab-catalogue/1"),
  paymentMode: z.enum(["disabled", "mock", "refref"]),
  cities: z.array(z.object({ cityId: z.string(), slug: z.string(), title: z.string() })),
  occurrences: z.array(z.object({
    occurrenceRef: z.string(), offerRef: z.string(), cityId: z.string(), title: z.string(),
    startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }),
    timezone: z.string().refine((value) => {
      try { new Intl.DateTimeFormat("ru-RU", { timeZone: value });return true; }
      catch { return false; }
    }), amountKopecks: z.number().int().nonnegative(), currency: z.literal("RUB"),
    /** A confirmed venue the organizer keeps private is announced to buyers only. */
    venue: z.discriminatedUnion("status", [
      z.object({ status: z.literal("CONFIRMED"), name: z.string().nullable(), address: z.string().nullable() }),
      z.object({ status: z.literal("TO_BE_ANNOUNCED"), disclosureText: z.string(), announceBy: z.iso.datetime({ offset: true }) }),
    ]),
    soldOut: z.boolean(),
  })),
});
export type LabCatalogue = z.infer<typeof labCatalogueSchema>;

export const labMeSchema = z.object({ customer: z.object({ id: z.string(), email_normalized: z.string() }).nullable() });
export const labHistorySchema = z.object({ orders: z.array(z.object({
  orderPublicId: z.string(), title: z.string(), offerRef: z.string(),
  productKind: z.enum(["LAB", "ONLINE_COURSE", "COURSE_BUNDLE"]), state: z.string(),
  amountKopecks: z.number().int().nonnegative(), currency: z.literal("RUB"), createdAt: z.string(),
})) });
