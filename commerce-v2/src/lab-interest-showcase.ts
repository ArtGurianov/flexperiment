import type Database from "better-sqlite3";
import { labShowcaseSchema, type LabShowcase } from "../../lib/lab-showcase-contract";
import { venueDisclosure, type LabOccurrenceRow } from "./lab-occurrences";
import type { LabInterestManifest } from "./lab-interest-legal";
import type { CommerceRuntimeConfig } from "./payment-mode";
import { storefrontSwitchStatus } from "./storefront-switch";

/**
 * FLEX-8 showcase: listed, scheduled, not yet started LAB occurrences whose offer is CLOSED or
 * PUBLIC, with dates and prices. ACCEPTANCE_ONLY offers stay private. It never projects capacity,
 * seat counts, sold-out guesses, allowlists or personal data, and it never writes: the storefront
 * switch is read without recording an observation.
 */
export function publicLabShowcase(db: Database.Database, config: Pick<CommerceRuntimeConfig, "paymentMode" | "deployEnvironment" | "storefrontSwitch">,
  interestAvailable: boolean, manifest: LabInterestManifest | undefined, now: Date): LabShowcase {
  const labSwitch = storefrontSwitchStatus(db, config).LAB;
  const reason = config.paymentMode === "disabled" ? "PAYMENTS_DISABLED" as const : labSwitch !== "OPEN" ? "STOREFRONT_CLOSED" as const : null;
  const cities = db.prepare("SELECT id AS cityId,slug,title FROM cities ORDER BY title,id").all();
  const rows = db.prepare(`SELECT occurrence.*,offer.sale_mode,offer.price_kopecks,offer.currency
    FROM lab_occurrences occurrence JOIN products product ON product.occurrence_ref=occurrence.occurrence_ref
    JOIN offers offer ON offer.product_id=product.id
    WHERE product.kind='LAB' AND product.withdrawn_at IS NULL AND offer.sale_mode IN ('CLOSED','PUBLIC')
      AND occurrence.lifecycle='SCHEDULED' AND occurrence.visibility='LISTED' AND occurrence.venue_status IS NOT NULL
      AND julianday(occurrence.starts_at)>julianday(?)
    ORDER BY occurrence.starts_at,occurrence.occurrence_ref,offer.offer_ref`).all(now.toISOString()) as Array<LabOccurrenceRow & {
      sale_mode: "CLOSED" | "PUBLIC"; price_kopecks: number; currency: string }>;
  const occurrences = rows.map((row) => {
    const venue = venueDisclosure(row)!;
    return {
      occurrenceRef: row.occurrence_ref, cityId: row.city_id, title: row.title, startsAt: row.starts_at, endsAt: row.ends_at,
      timezone: row.timezone, amountKopecks: row.price_kopecks, currency: row.currency,
      venue: venue.status === "CONFIRMED"
        ? { status: venue.status, name: venue.public ? venue.name : null, address: venue.public ? venue.address : null }
        : { status: venue.status, disclosureText: venue.disclosureText, announceBy: venue.announceBy },
      sales: reason === null && row.sale_mode === "PUBLIC" ? "OPEN" as const : "CLOSED" as const,
    };
  });
  const open = occurrences.some((occurrence) => occurrence.sales === "OPEN");
  return labShowcaseSchema.parse({
    schema: "flexperiment.lab-showcase/1",
    // Sales are OPEN only if at least one listed event can actually be bought.
    sales: { state: open ? "OPEN" : "CLOSED", reason: open ? null : reason ?? "OFFERS_CLOSED" },
    interest: { available: interestAvailable && cities.length > 0, consent: manifest?.consent ?? null, privacy: manifest?.privacy ?? null },
    cities, occurrences,
  });
}
