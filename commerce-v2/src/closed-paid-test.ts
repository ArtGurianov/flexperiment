import { createHash } from "node:crypto";
import { CLOSED_PAID_TEST_AMOUNT, CLOSED_PAID_TEST_COURSE, CLOSED_PAID_TEST_OFFER } from "../../lib/closed-paid-test-profile";
import type { CommerceRuntimeConfig } from "./payment-mode";
import type { FrozenFiscalPolicy } from "./fiscal-policy";

export const buyerEmailSha256 = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export function assertClosedPaidTestFiscal(config: Pick<CommerceRuntimeConfig, "closedPaidTest">, fiscal: FrozenFiscalPolicy) {
  if (config.closedPaidTest && (fiscal.itemName !== "Доступ к видеоматериалу «Test Course»" || fiscal.taxSystem !== "USN_INCOME"
    || fiscal.vatCode !== "NONE" || fiscal.paymentMethod !== "FULL_PAYMENT" || fiscal.paymentObject !== "SERVICE")) {
    throw new Error("CLOSED_PAID_TEST_FISCAL_POLICY_REFUSED");
  }
}
export function assertClosedPaidTestOffer(config: Pick<CommerceRuntimeConfig, "closedPaidTest">, offer: {
  kind: string; accessModel: string; saleMode: string; offerRef: string; courseRef?: string | null; priceKopecks: number;
  acceptanceAllowlist: readonly string[];
}, customerEmail?: string) {
  if (!config.closedPaidTest) return;
  if (offer.kind !== "ONLINE_COURSE" || offer.accessModel !== "PAID" || offer.saleMode !== "ACCEPTANCE_ONLY"
    || offer.offerRef !== CLOSED_PAID_TEST_OFFER || offer.courseRef !== CLOSED_PAID_TEST_COURSE
    || offer.priceKopecks !== CLOSED_PAID_TEST_AMOUNT || offer.acceptanceAllowlist.length !== 1
    || buyerEmailSha256(offer.acceptanceAllowlist[0]) !== config.closedPaidTest.buyerEmailSha256
    || (customerEmail !== undefined && buyerEmailSha256(customerEmail) !== config.closedPaidTest.buyerEmailSha256)) {
    throw new Error("CLOSED_PAID_TEST_SCOPE_REFUSED");
  }
}

export function assertClosedPaidTestPrice(config: Pick<CommerceRuntimeConfig, "closedPaidTest">,
  pricing: { baseAmountKopecks: number; finalAmountKopecks: number; discountKopecks: number }, merchantDiscount = 0) {
  if (config.closedPaidTest && (pricing.baseAmountKopecks !== CLOSED_PAID_TEST_AMOUNT
    || pricing.finalAmountKopecks !== CLOSED_PAID_TEST_AMOUNT || pricing.discountKopecks !== 0 || merchantDiscount !== 0)) {
    throw new Error("CLOSED_PAID_TEST_PRICE_REFUSED");
  }
}
