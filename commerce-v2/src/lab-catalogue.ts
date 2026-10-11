import type Database from "better-sqlite3";
import { labCatalogueSchema, type LabCatalogue } from "../../lib/lab-v2-contract";
import type { PaymentMode } from "./payment-mode";

/** Only published offers. Never project acceptance allowlists, capacity or personal data. */
export function publicLabCatalogue(db: Database.Database, paymentMode: PaymentMode, now: Date): LabCatalogue {
  const cities = db.prepare("SELECT id AS cityId,slug,title FROM cities ORDER BY title,id").all();
  const occurrences = db.prepare(`SELECT occurrence.occurrence_ref AS occurrenceRef,offer.offer_ref AS offerRef,
      occurrence.city_id AS cityId,occurrence.title,occurrence.starts_at AS startsAt,
      occurrence.ends_at AS endsAt,occurrence.timezone,offer.price_kopecks AS amountKopecks,offer.currency
    FROM lab_occurrences occurrence JOIN products product ON product.occurrence_ref=occurrence.occurrence_ref
    JOIN offers offer ON offer.product_id=product.id
    WHERE product.kind='LAB' AND product.withdrawn_at IS NULL
      AND occurrence.sales_status='PUBLIC' AND offer.sale_mode='PUBLIC'
      AND julianday(occurrence.ends_at)>julianday(?)
    ORDER BY occurrence.starts_at,occurrence.occurrence_ref,offer.offer_ref`).all(now.toISOString());
  return labCatalogueSchema.parse({ schema: "flexperiment.lab-catalogue/1", paymentMode, cities, occurrences });
}
