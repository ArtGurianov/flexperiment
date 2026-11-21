import type Database from "better-sqlite3";
import { closingEligibility, labOccurrenceCancellationState, listServiceRenderedFacts, type ServiceRenderedFact } from "../../src/service-rendered";

/**
 * Test-only stand-in for C's FINAL_SETTLEMENT issuance job (FLEX-119, draft #289 §7/§7.1), so FLEX-85 can
 * be proven end to end on D's real fact. Not production code and not C's implementation: C owns the
 * outbox, the sealed contact and the adapter. It follows C's published rules only: key
 * `fiscal:FINAL_SETTLEMENT:{orderLineId}`, one effect per key, and a repeat under the same key only
 * after a read-back answered NOT_FOUND.
 */
export type Observation = { state: "ISSUED"; providerRef: string } | { state: "NOT_FOUND" } | { state: "REJECTED"; code: string };
export type SubmitRequest = { key: string; orderLineId: string; lines: unknown[]; advanceOffsetKopecks: number; newPaymentKopecks: 0; fact: ServiceRenderedFact };

export class FixtureFiscalProvider {
  readonly receipts = new Map<string, { providerRef: string; request: SubmitRequest }>();
  readonly submissions: SubmitRequest[] = [];
  readonly readBacks: string[] = [];
  loseNextAnswer = false;
  readBackUnavailable = false;
  async submit(request: SubmitRequest): Promise<Observation> {
    this.submissions.push(request);
    const receipt = this.receipts.get(request.key) ?? { providerRef: `fixture-receipt-${this.receipts.size + 1}`, request };
    this.receipts.set(request.key, receipt);
    if (this.loseNextAnswer) { this.loseNextAnswer = false; throw new TypeError("socket hang up"); }
    return { state: "ISSUED", providerRef: receipt.providerRef };
  }
  async readBack(key: string): Promise<Observation> {
    this.readBacks.push(key);
    if (this.readBackUnavailable) throw new TypeError("fetch failed");
    const receipt = this.receipts.get(key);
    return receipt ? { state: "ISSUED", providerRef: receipt.providerRef } : { state: "NOT_FOUND" };
  }
}

export type JobState = "UNKNOWN" | "ISSUED" | "HANDOFF";
export const finalSettlementKey = (orderLineId: string) => `fiscal:FINAL_SETTLEMENT:${orderLineId}`;

/** One pass of the stand-in job. `store` is its durable state (C's table in production). */
export async function runFixtureIssuance(db: Database.Database, provider: FixtureFiscalProvider, store: Map<string, { state: JobState; code?: string; providerRef?: string }>,
  contourOf: (orderLineId: string) => string | null) {
  for (const fact of listServiceRenderedFacts(db, { limit: 500 })) {
    const key = finalSettlementKey(fact.orderLineId);
    const current = store.get(key);
    if (current?.state === "ISSUED" || current?.state === "HANDOFF") continue;
    const eligibility = closingEligibility(fact, contourOf(fact.orderLineId), labOccurrenceCancellationState(db, fact.occurrenceRef));
    if (!eligibility.eligible) { store.set(key, { state: "HANDOFF", code: eligibility.code }); continue; }
    let observation: Observation | undefined;
    if (current?.state === "UNKNOWN") {
      try { observation = await provider.readBack(key); } catch { continue; }
      if (observation.state !== "NOT_FOUND") { store.set(key, observation.state === "ISSUED" ? { state: "ISSUED", providerRef: observation.providerRef } : { state: "HANDOFF", code: observation.code }); continue; }
    }
    const line = db.prepare("SELECT line.fiscal_item_json,orders.total_kopecks FROM order_lines line JOIN orders ON orders.id=line.order_id WHERE line.id=?")
      .get(fact.orderLineId) as { fiscal_item_json: string; total_kopecks: number };
    store.set(key, { state: "UNKNOWN" }); // Claimed before the call: a crash leaves it to read-back.
    try { observation = await provider.submit({ key, orderLineId: fact.orderLineId, lines: [JSON.parse(line.fiscal_item_json)],
      advanceOffsetKopecks: line.total_kopecks, newPaymentKopecks: 0, fact }); }
    catch { continue; }
    store.set(key, observation.state === "ISSUED" ? { state: "ISSUED", providerRef: observation.providerRef } : { state: "HANDOFF", code: observation.state });
  }
}
