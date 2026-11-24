import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { ErasureLedgerError, erasureSubject, type ErasureKeys, type ErasureSubject } from "./erasure-ledger";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const instant = z.iso.datetime();
const scope = z.enum(["canary", "production"]);
const disposition = <T extends readonly [string, ...string[]]>(actions: T) => z.object({
  action: z.enum(actions), basisRef: ref, until: instant,
}).strict();

export const reviewedPlanSchema = z.object({
  version: z.literal(1),
  scope,
  requestId: z.uuid(),
  packageE: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), sha256: digest }).strict(),
  identityVerificationRef: ref,
  executeBy: instant,
  obligationsSha256: digest,
  continuityRef: ref.optional(),
  categories: z.object({
    account: disposition(["CLOSE", "CLOSE_WITH_CONTINUITY"]),
    credentials: disposition(["REVOKE"]),
    consents: disposition(["DELETE"]),
    marketing: disposition(["SUPPRESS_AND_DELETE"]),
    freeLearning: disposition(["DELETE", "RETAIN"]),
    progress: disposition(["DELETE", "RETAIN"]),
    customerContact: disposition(["RETAIN"]),
    financeAndFiscal: disposition(["RETAIN"]),
    paidRightsAndPerformance: disposition(["RETAIN"]),
    legalAndAuditEvidence: disposition(["RETAIN"]),
  }).strict(),
}).strict().refine(plan => (plan.categories.account.action === "CLOSE_WITH_CONTINUITY") === !!plan.continuityRef);

export type ReviewedErasurePlan = z.infer<typeof reviewedPlanSchema>;
type Category = keyof ReviewedErasurePlan["categories"];
export const reviewedLedgerPlanSchema = z.object({
  plan: reviewedPlanSchema, planSha256: digest, operatorId: ref, approvedAt: instant, approvalSha256: digest,
}).strict();
export type ReviewedLedgerPlan = z.infer<typeof reviewedLedgerPlanSchema>;

export const reviewedApprovalSchema = z.object({
  operatorId: ref, approvedAt: instant, planSha256: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type ReviewedApproval = z.infer<typeof reviewedApprovalSchema>;

const policySchema = z.object({
  version: z.literal(1), scope, packageE: reviewedPlanSchema.shape.packageE,
  validUntil: instant,
  operators: z.record(ref, z.object({ publicKey: z.string().max(256), authorizedUntil: instant }).strict()),
  cases: z.record(z.uuid(), z.object({
    customer: digest, identityVerificationRef: ref, continuityRef: ref.optional(), latestExecuteAt: instant,
  }).strict()),
  rules: z.array(z.object({ category: ref, action: ref, basisRef: ref, earliestUntil: instant, latestUntil: instant }).strict()).min(1).max(100),
  // Current hold registry, keyed by subject-key generation and customer HMAC.
  holds: z.array(z.object({ keyId: ref, customer: digest }).strict()).max(10_000),
}).strict();

export function erasurePlanRefused(code: string): never { throw new ErasureLedgerError(code); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reviewedErasurePlanHash(plan: ReviewedErasurePlan, subject: ErasureSubject) {
  return createHash("sha256").update(canonical(["flexperiment-reviewed-erasure-plan-v1", plan, subject])).digest("hex");
}

export function reviewedApprovalHash(approval: ReviewedApproval) {
  return createHash("sha256").update(canonical(approval)).digest("hex");
}

export function reviewedApprovalBytes(approval: Omit<ReviewedApproval, "signature">) {
  return Buffer.from(canonical(["flexperiment-reviewed-erasure-execute-v1", approval]));
}

export function assertReviewedPolicy(input: {
  policy: unknown; plan: ReviewedErasurePlan; subject: ErasureSubject; binding: { email: string; customerId: string; userId: string };
  keys: ErasureKeys; now: Date; approval?: ReviewedApproval;
}) {
  const parsed = policySchema.safeParse(input.policy);
  const { plan, subject, binding, keys, now, approval } = input;
  if (!parsed.success || parsed.data.scope !== plan.scope ||
    canonical(parsed.data.packageE) !== canonical(plan.packageE) || Date.parse(parsed.data.validUntil) <= now.getTime()) {
    return erasurePlanRefused("ERASURE_AWAITING_E_POLICY");
  }
  const policy = parsed.data;
  for (const hold of policy.holds) {
    const bound = erasureSubject(keys, hold.keyId, plan.scope, binding);
    if (hold.customer === bound.customer) erasurePlanRefused("ERASURE_LEGAL_HOLD");
  }
  const time = now.getTime();
  const approvedCase = policy.cases[plan.requestId];
  if (!approvedCase || approvedCase.customer !== subject.customer || approvedCase.identityVerificationRef !== plan.identityVerificationRef ||
    approvedCase.continuityRef !== plan.continuityRef) erasurePlanRefused("ERASURE_CASE_ADMISSION_REQUIRED");
  if (!Number.isFinite(time) || Date.parse(plan.executeBy) < time) erasurePlanRefused("ERASURE_PLAN_EXPIRED");
  if (Date.parse(plan.executeBy) > Date.parse(approvedCase.latestExecuteAt)) erasurePlanRefused("ERASURE_PLAN_PERIOD_INVALID");
  for (const [category, step] of Object.entries(plan.categories) as [Category, ReviewedErasurePlan["categories"][Category]][]) {
    const candidates = policy.rules.filter(rule => rule.category === category && rule.action === step.action && rule.basisRef === step.basisRef);
    if (candidates.length !== 1) {
      erasurePlanRefused("ERASURE_PLAN_CATEGORY_NOT_AUTHORIZED");
    }
    const until = Date.parse(step.until);
    const retaining = step.action === "RETAIN";
    const { earliestUntil, latestUntil } = candidates[0];
    if (until < time || until < Date.parse(earliestUntil) || until > Date.parse(latestUntil) ||
      (!retaining && until > Date.parse(plan.executeBy))) {
      erasurePlanRefused("ERASURE_PLAN_PERIOD_INVALID");
    }
  }
  const planSha256 = reviewedErasurePlanHash(plan, subject);
  if (!approval) return planSha256;
  const { operatorId, approvedAt, signature, planSha256: approvedHash } = approval;
  const operator = Object.hasOwn(policy.operators, operatorId) ? policy.operators[operatorId] : undefined;
  let key;
  try { if (operator) key = createPublicKey(operator.publicKey); }
  catch { erasurePlanRefused("ERASURE_OPERATOR_APPROVAL_INVALID"); }
  const bytes = Buffer.from(signature, "base64url");
  if (approvedHash !== planSha256 || !operator || Date.parse(operator.authorizedUntil) <= time ||
    Date.parse(approvedAt) > time || !key || key.asymmetricKeyType !== "ed25519" ||
    bytes.toString("base64url") !== signature ||
    !verify(null, reviewedApprovalBytes({ operatorId, approvedAt, planSha256 }), key, bytes)) {
    erasurePlanRefused("ERASURE_OPERATOR_APPROVAL_INVALID");
  }
  return planSha256;
}
