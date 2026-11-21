import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  admitFinalSettlement, admitRefund, applyFiscalObservation, applyPaymentObservation, applyRefundObservation, beginFiscalEvent, beginPayment,
  beginRefund, buyerPaymentStatus, buyerRefundStatus, NATIVE_CONTRACT_VERSION, paymentReceiptMethod, routeContour,
  type FiscalBinding, type FiscalObservation, type FiscalRecord, type FiscalizationMode, type PaymentBinding, type PaymentObservation,
  type PaymentRecord, type ProductKind, type RefundBinding, type RefundObservation, type RefundRecord,
} from "../src/native-payment-contract";

// The fixtures are the contract handed to checkout (FLEX-122), LAB and fiscal (D, FLEX-85): every step
// below is replayed through the decision tables, so a fixture and the code cannot drift apart.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/native-payments");
const load = <T>(name: string) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;

type Expect = { state: string; effects: string[]; reason?: string };
type Step<O> = { observe: O; expect: Expect; mayInitiate?: boolean };
type Scenario<O> = { id: string; title: string; steps: Step<O>[]; totals?: Record<string, number> };

const payments = load<{
  contract: string; bindings: Record<string, PaymentBinding>;
  begin: { mayInitiate: boolean; expect: Expect }[];
  scenarios: (Scenario<PaymentObservation> & { binding: string; kind: ProductKind; fiscalizationMode: FiscalizationMode })[];
}>("payment-scenarios.json");
const refunds = load<{
  contract: string; binding: RefundBinding; begin: { expect: Expect };
  admission: { id: string; input: Parameters<typeof admitRefund>[0]; expect: unknown }[];
  scenarios: (Scenario<RefundObservation> & { fiscalizationMode: FiscalizationMode })[];
}>("refund-scenarios.json");
const fiscal = load<{
  contract: string; begin: { mode: FiscalizationMode; expect: Expect }[];
  receiptMethod: { kind: ProductKind; policy: string; expect?: string; error?: string }[];
  finalSettlementAdmission: { id: string; input: Parameters<typeof admitFinalSettlement>[0]; expect: unknown }[];
  scenarios: (Scenario<FiscalObservation> & { binding: FiscalBinding })[];
}>("fiscal-scenarios.json");
const buyer = load<{
  contract: string;
  payment: { state: Parameters<typeof buyerPaymentStatus>[0]; kind: ProductKind; expect: string }[];
  refund: { state: Parameters<typeof buyerRefundStatus>[0]; expect: string }[];
  routing: { order: Parameters<typeof routeContour>[0]; expect?: string; error?: string }[];
}>("buyer-states.json");

const FINANCIAL_EFFECTS = new Set(["PROVIDER_CREATE", "REPLAY_CREATE_SAME_KEY", "GRANT", "PROVIDER_REFUND_SUBMIT", "REPLAY_REFUND_SAME_KEY", "REVOKE_ACCESS"]);

function counted(all: string[][]) {
  const totals: Record<string, number> = {};
  for (const effects of all) for (const effect of effects) totals[effect] = (totals[effect] ?? 0) + 1;
  return totals;
}
const decided = (d: { state: string; effects: readonly string[]; reason?: string }) =>
  ({ state: d.state, effects: [...d.effects], ...(d.reason ? { reason: d.reason } : {}) });

describe("native payment contract fixtures", () => {
  it("all fixtures name this contract version", () => {
    for (const file of [payments, refunds, fiscal, buyer]) expect(file.contract).toBe(NATIVE_CONTRACT_VERSION);
  });

  it("begins a payment only under sales admission", () => {
    for (const c of payments.begin) expect(decided(beginPayment({ mayInitiate: c.mayInitiate }))).toEqual(c.expect);
  });

  describe.each(payments.scenarios.map((s) => [s.id, s] as const))("payment %s", (_id, scenario) => {
    it(scenario.title, () => {
      const binding = payments.bindings[scenario.binding]!;
      let record: PaymentRecord = { state: "CREATING", providerPaymentId: null };
      const all: string[][] = [];
      for (const [index, step] of scenario.steps.entries()) {
        const next = applyPaymentObservation(record, binding, step.observe,
          { mayInitiate: step.mayInitiate ?? true, kind: scenario.kind, fiscalizationMode: scenario.fiscalizationMode });
        expect(decided(next), `step ${index + 1}`).toEqual(step.expect);
        // Access follows only a bound provider READ_BACK of PAID, and only on the transition into PAID.
        if (next.effects.includes("GRANT")) {
          expect(step.observe).toMatchObject({ source: "READ_BACK", outcome: "FOUND", status: "PAID" });
          expect(record.state).not.toBe("PAID");
        }
        all.push([...next.effects]);
        record = next;
      }
      const totals = counted(all);
      expect(totals.GRANT ?? 0).toBeLessThanOrEqual(1);
      for (const [effect, count] of Object.entries(scenario.totals ?? {})) expect(totals[effect] ?? 0, effect).toBe(count);
    });
  });
});

describe("native refund contract fixtures", () => {
  it("begins with one submission of the sealed envelope", () => {
    expect(decided(beginRefund())).toEqual(refunds.begin.expect);
  });

  it.each(refunds.admission.map((c) => [c.id, c] as const))("admission %s", (_id, c) => {
    expect(admitRefund(c.input)).toEqual(c.expect);
  });

  describe.each(refunds.scenarios.map((s) => [s.id, s] as const))("refund %s", (_id, scenario) => {
    it(scenario.title, () => {
      let record: RefundRecord = { state: "SUBMITTING", providerRefundId: null };
      const all: string[][] = [];
      for (const [index, step] of scenario.steps.entries()) {
        const next = applyRefundObservation(record, refunds.binding, step.observe, { fiscalizationMode: scenario.fiscalizationMode });
        expect(decided(next), `step ${index + 1}`).toEqual(step.expect);
        if (next.effects.includes("REVOKE_ACCESS")) {
          expect(step.observe).toMatchObject({ source: "READ_BACK", outcome: "FOUND", status: "SUCCEEDED" });
          expect(record.state).not.toBe("SUCCEEDED");
        }
        all.push([...next.effects]);
        record = next;
      }
      const totals = counted(all);
      expect(totals.REVOKE_ACCESS ?? 0).toBeLessThanOrEqual(1);
      for (const [effect, count] of Object.entries(scenario.totals ?? {})) expect(totals[effect] ?? 0, effect).toBe(count);
    });
  });
});

describe("fiscal port contract fixtures", () => {
  it("submits in MERCHANT mode and records nothing to submit in PROVIDER mode", () => {
    for (const c of fiscal.begin) expect(decided(beginFiscalEvent(c.mode))).toEqual(c.expect);
  });

  it("derives the payment receipt from the frozen qualified policy, refusing unqualified combinations", () => {
    for (const c of fiscal.receiptMethod) {
      if (c.error) expect(() => paymentReceiptMethod(c.kind, c.policy)).toThrow(c.error);
      else expect(paymentReceiptMethod(c.kind, c.policy)).toBe(c.expect);
    }
  });

  it.each(fiscal.finalSettlementAdmission.map((c) => [c.id, c] as const))("SERVICE_RENDERED → FINAL_SETTLEMENT admission %s", (_id, c) => {
    expect(admitFinalSettlement(c.input)).toEqual(c.expect);
  });

  describe.each(fiscal.scenarios.map((s) => [s.id, s] as const))("fiscal %s", (_id, scenario) => {
    it(scenario.title, () => {
      let record: FiscalRecord = { state: "SUBMITTING", providerReceiptId: null };
      const all: string[][] = [];
      for (const [index, step] of scenario.steps.entries()) {
        const next = applyFiscalObservation(record, scenario.binding, step.observe);
        expect(decided(next), `step ${index + 1}`).toEqual(step.expect);
        // Fiscal reconciliation never moves money and never grants or revokes access.
        for (const effect of next.effects) expect(FINANCIAL_EFFECTS.has(effect), effect).toBe(false);
        all.push([...next.effects]);
        record = next;
      }
      for (const [effect, count] of Object.entries(scenario.totals ?? {})) expect(counted(all)[effect] ?? 0, effect).toBe(count);
    });
  });
});

describe("buyer projection and historical routing", () => {
  it.each(buyer.payment.map((c) => [`${c.state}/${c.kind}`, c] as const))("payment %s", (_id, c) => {
    expect(buyerPaymentStatus(c.state, c.kind)).toBe(c.expect);
  });
  it.each(buyer.refund.map((c) => [c.state, c] as const))("refund %s", (_id, c) => {
    expect(buyerRefundStatus(c.state)).toBe(c.expect);
  });
  it("routes every order to the contour stored with it; a historical RC.2 order never reaches the native provider", () => {
    for (const c of buyer.routing) {
      if (c.error) expect(() => routeContour(c.order)).toThrow(c.error);
      else expect(routeContour(c.order)).toBe(c.expect);
    }
  });
});
