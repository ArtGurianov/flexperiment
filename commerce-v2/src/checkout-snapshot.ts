import { createHash } from "node:crypto";

export type CheckoutSnapshotConfig = {
  readonly merchantId: string;
  readonly fiscalizationMode: "PROVIDER" | "MERCHANT";
  readonly taxSystem: "USN_INCOME" | "USN_INCOME_OUTCOME";
  readonly vatCode: "NONE";
  readonly paymentMethod: string;
  readonly paymentObject: "SERVICE";
};

export type SharedCheckoutSnapshotV1 = {
  readonly schema: "refref.shared-checkout-snapshot/1";
  readonly merchantId: string;
  readonly merchantOrderRef: string;
  readonly currency: "RUB";
  readonly referralResolutionId: string;
  readonly termsVersionId: string | null;
  readonly lines: Array<{
    readonly lineRef: string;
    readonly offerRef: string;
    readonly unitRef?: string;
    readonly quantity: 1;
    readonly merchantOfferAmountKopecks: number;
    readonly referralDiscountAmountKopecks: number;
    readonly finalAmountKopecks: number;
    readonly serviceStartsAt?: string;
    readonly serviceEndsAt?: string;
  }>;
  readonly totalContractAmountKopecks: number;
  readonly paymentObligations: Array<{
    readonly obligationRef: "full";
    readonly kind: "FULL";
    readonly executionMode: "ORCHESTRATED";
    readonly amountKopecks: number;
    readonly allocations: Array<{ readonly lineRef: string; readonly amountKopecks: number }>;
    readonly fiscalizationMode: "PROVIDER" | "MERCHANT";
    readonly fiscal: {
      readonly taxSystem: "USN_INCOME" | "USN_INCOME_OUTCOME";
      readonly items: Array<{
        readonly lineRef: string;
        readonly name: string;
        readonly quantity: 1;
        readonly amountKopecks: number;
        readonly vatCode: "NONE";
        readonly paymentMethod: string;
        readonly paymentObject: "SERVICE";
      }>;
    };
  }>;
  readonly legalReleaseRef: string;
  readonly legalReleaseHash: string;
};

const canonical = (value: unknown, path = "$"): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`CHECKOUT_SNAPSHOT_NON_INTEGER:${path}`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item, index) => canonical(item, `${path}[${index}]`)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) throw new Error(`CHECKOUT_SNAPSHOT_UNDEFINED:${path}.${key}`);
      return `${JSON.stringify(key)}:${canonical(object[key], `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`CHECKOUT_SNAPSHOT_NOT_JSON:${path}`);
};

const byRef = <T extends Record<string, unknown>>(values: readonly T[], key: string) => [...values]
  .sort((left, right) => String(left[key]) < String(right[key]) ? -1 : String(left[key]) > String(right[key]) ? 1 : 0);

const normalizedSnapshot = (snapshot: SharedCheckoutSnapshotV1): SharedCheckoutSnapshotV1 => ({
  ...snapshot,
  lines: byRef(snapshot.lines, "lineRef") as SharedCheckoutSnapshotV1["lines"],
  paymentObligations: byRef(snapshot.paymentObligations, "obligationRef").map((obligation) => ({
    ...obligation,
    allocations: byRef(obligation.allocations, "lineRef"),
  })) as SharedCheckoutSnapshotV1["paymentObligations"],
});

export const canonicalCheckoutSnapshotJson = (snapshot: SharedCheckoutSnapshotV1) => canonical(normalizedSnapshot(snapshot), "$");

export const checkoutSnapshotHash = (snapshot: SharedCheckoutSnapshotV1) =>
  `refref-jcs-1:${createHash("sha256").update(canonicalCheckoutSnapshotJson(snapshot), "utf8").digest("hex")}`;

export function buildCheckoutSnapshot(input: {
  readonly config: CheckoutSnapshotConfig;
  readonly merchantOrderRef: string;
  readonly line: {
    readonly lineRef: string;
    readonly offerRef: string;
    readonly unitRef?: string;
    readonly merchantOfferAmountKopecks: number;
    readonly referralDiscountAmountKopecks: number;
    readonly serviceStartsAt?: string;
    readonly serviceEndsAt?: string;
    readonly fiscalName: string;
  };
  readonly referralResolutionId: string;
  readonly termsVersionId: string | null;
  readonly legalReleaseRef: string;
  readonly legalReleaseHash: string;
}) {
  const finalAmountKopecks = input.line.merchantOfferAmountKopecks - input.line.referralDiscountAmountKopecks;
  if (!Number.isSafeInteger(input.line.merchantOfferAmountKopecks) || input.line.merchantOfferAmountKopecks <= 0
    || !Number.isSafeInteger(input.line.referralDiscountAmountKopecks) || input.line.referralDiscountAmountKopecks < 0
    || finalAmountKopecks <= 0) throw new Error("CHECKOUT_SNAPSHOT_AMOUNT_INVALID");
  if (!input.line.fiscalName.trim() || !input.legalReleaseRef.trim() || !/^[a-f0-9]{64}$/.test(input.legalReleaseHash)) {
    throw new Error("CHECKOUT_SNAPSHOT_EVIDENCE_INVALID");
  }
  const line = {
    lineRef: input.line.lineRef,
    offerRef: input.line.offerRef,
    ...(input.line.unitRef === undefined ? {} : { unitRef: input.line.unitRef }),
    quantity: 1 as const,
    merchantOfferAmountKopecks: input.line.merchantOfferAmountKopecks,
    referralDiscountAmountKopecks: input.line.referralDiscountAmountKopecks,
    finalAmountKopecks,
    ...(input.line.serviceStartsAt === undefined ? {} : { serviceStartsAt: input.line.serviceStartsAt }),
    ...(input.line.serviceEndsAt === undefined ? {} : { serviceEndsAt: input.line.serviceEndsAt }),
  };
  const fiscalItem = {
    lineRef: input.line.lineRef,
    name: input.line.fiscalName.trim(),
    quantity: 1 as const,
    amountKopecks: finalAmountKopecks,
    vatCode: input.config.vatCode,
    paymentMethod: input.config.paymentMethod,
    paymentObject: input.config.paymentObject,
  };
  const snapshot: SharedCheckoutSnapshotV1 = {
    schema: "refref.shared-checkout-snapshot/1",
    merchantId: input.config.merchantId,
    merchantOrderRef: input.merchantOrderRef,
    currency: "RUB",
    referralResolutionId: input.referralResolutionId,
    termsVersionId: input.termsVersionId,
    lines: [line],
    totalContractAmountKopecks: finalAmountKopecks,
    paymentObligations: [{
      obligationRef: "full",
      kind: "FULL",
      executionMode: "ORCHESTRATED",
      amountKopecks: finalAmountKopecks,
      allocations: [{ lineRef: input.line.lineRef, amountKopecks: finalAmountKopecks }],
      fiscalizationMode: input.config.fiscalizationMode,
      fiscal: { taxSystem: input.config.taxSystem, items: [fiscalItem] },
    }],
    legalReleaseRef: input.legalReleaseRef,
    legalReleaseHash: input.legalReleaseHash,
  };
  return { snapshot: normalizedSnapshot(snapshot), snapshotHash: checkoutSnapshotHash(snapshot), fiscalItem };
}
