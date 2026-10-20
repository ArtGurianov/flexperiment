import type Database from "better-sqlite3";
import { labCatalogueSchema, type LabCatalogue } from "../../lib/lab-v2-contract";
import { labSeatInventory, venueDisclosure, type LabOccurrenceRow } from "./lab-occurrences";
import type { PaymentMode } from "./payment-mode";

/**
 * Only listed, scheduled, not yet started occurrences of a PUBLIC offer. Never project acceptance
 * allowlists, capacity, seat counts or personal data; a confirmed venue appears only when public.
 */
export function publicLabCatalogue(db: Database.Database, paymentMode: PaymentMode, now: Date): LabCatalogue {
  const cities = db.prepare("SELECT id AS cityId,slug,title FROM cities ORDER BY title,id").all();
  const rows = db.prepare(`SELECT occurrence.*,offer.offer_ref,offer.price_kopecks,offer.currency
    FROM lab_occurrences occurrence JOIN products product ON product.occurrence_ref=occurrence.occurrence_ref
    JOIN offers offer ON offer.product_id=product.id
    WHERE product.kind='LAB' AND product.withdrawn_at IS NULL AND offer.sale_mode='PUBLIC'
      AND occurrence.lifecycle='SCHEDULED' AND occurrence.visibility='LISTED' AND occurrence.venue_status IS NOT NULL
      AND julianday(occurrence.starts_at)>julianday(?)
    ORDER BY occurrence.starts_at,occurrence.occurrence_ref,offer.offer_ref`).all(now.toISOString()) as Array<LabOccurrenceRow & {
      offer_ref: string; price_kopecks: number; currency: string }>;
  const occurrences = rows.map((row) => {
    const venue = venueDisclosure(row)!;
    return {
      occurrenceRef: row.occurrence_ref, offerRef: row.offer_ref, cityId: row.city_id, title: row.title,
      startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone, amountKopecks: row.price_kopecks, currency: row.currency,
      venue: venue.status === "CONFIRMED"
        ? { status: venue.status, name: venue.public ? venue.name : null, address: venue.public ? venue.address : null }
        : { status: venue.status, disclosureText: venue.disclosureText, announceBy: venue.announceBy },
      soldOut: labSeatInventory(db, row, now.toISOString()).available < 1,
    };
  });
  return labCatalogueSchema.parse({ schema: "flexperiment.lab-catalogue/1", paymentMode, cities, occurrences });
}
