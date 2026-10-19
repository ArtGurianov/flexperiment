import { z } from "zod";

export const labGuestQuoteSchema = z.object({
  state: z.literal("PRICE_REVIEW_REQUIRED"), quoteId: z.string(), finalAmountKopecks: z.number().int().positive(), expiresAt: z.string(),
  occurrence: z.object({ title: z.string(), startsAt: z.string(), endsAt: z.string(), timezone: z.string(),
    venue: z.discriminatedUnion("status", [z.object({ status: z.literal("CONFIRMED"), name: z.string(), address: z.string() }),
      z.object({ status: z.literal("TO_BE_ANNOUNCED"), disclosureText: z.string(), announceBy: z.string() })]) }),
  labLegal: z.object({ releaseVersion: z.string(), manifestSha256: z.string(),
    documents: z.array(z.object({ kind: z.string(), version: z.string(), url: z.url().refine(url => url.startsWith("https://")) })) }),
});
export type LabGuestQuote = z.infer<typeof labGuestQuoteSchema>;
export const labGuestTicketSchema = z.object({
  orderPublicId: z.string(), ticketId: z.string().optional(), status: z.enum(["NOT_ISSUED", "VALID", "USED", "VOID"]),
  usedAt: z.string().nullable().optional(), qrImage: z.string().startsWith("data:image/png;base64,").optional(),
  occurrence: labGuestQuoteSchema.shape.occurrence.optional(),
});
export type LabGuestTicket = z.infer<typeof labGuestTicketSchema>;
