import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ErasureCustodian } from "./erasure-custody";
import { erasurePseudonym, erasureSubject, type ErasureBundle, type ErasureKeys, type ErasureLedgerStore, type VerifiedErasureLedger } from "./erasure-ledger";
import { type DrainedErasureRuntime, type ErasureRuntimeFence } from "./erasure-fence";
import { applyDrainedRuntimeErasure, assertReviewedRestoreSchema } from "./erasure-restore";
import { assertReviewedPolicy, erasurePlanRefused, reviewedApprovalHash, reviewedApprovalSchema, reviewedErasurePlanHash, reviewedPlanSchema } from "./erasure-plan";
import { checkReviewedTarget, readReviewedBinding, readReviewedInventory, reviewedReceipt } from "./erasure-reviewed-application";
import { hasTable } from "./my-session-storage";

const customerId = z.string().min(1).max(256);
const reviewedAction = { customerId, plan: reviewedPlanSchema };
export const reviewedReadOperations = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("review-inventory"), customerId }).strict(),
  z.object({ operation: z.literal("review-dry-run"), ...reviewedAction }).strict(),
  z.object({ operation: z.literal("review-status"), requestId: z.uuid() }).strict(),
]);
export const reviewedExecuteOperation = z.object({
  operation: z.literal("review-execute"), ...reviewedAction, approval: reviewedApprovalSchema,
}).strict();

type ReviewExecution = z.infer<typeof reviewedExecuteOperation>;
type Context = {
  db: Database.Database; scope: "canary" | "production"; keys: ErasureKeys; subjectKeyId: string;
  readPolicy: () => unknown; now: () => Date;
};

function assertSchema(db: Database.Database) {
  assertReviewedRestoreSchema(db);
  if (!hasTable(db, "reviewed_erasure_receipts")) erasurePlanRefused("ERASURE_REVIEWED_SCHEMA_REQUIRED");
}

function prepare(context: Context, input: { customerId: string; plan: ReviewExecution["plan"]; approval?: ReviewExecution["approval"] }) {
  const { db, scope, keys, subjectKeyId, now } = context;
  assertSchema(db);
  if (input.plan.scope !== scope) erasurePlanRefused("ERASURE_SCOPE_MISMATCH");
  const binding = readReviewedBinding(db, input.customerId);
  const subject = erasureSubject(keys, subjectKeyId, scope, binding);
  const planSha256 = assertReviewedPolicy({ policy: context.readPolicy(), plan: input.plan, subject, binding, keys, now: now(), approval: input.approval });
  return { subject, planSha256, ...checkReviewedTarget(db, binding, input.plan) };
}

export function readReviewedErasure(context: Context, op: Exclude<z.infer<typeof reviewedReadOperations>, { operation: "review-status" }>) {
  const { db } = context;
  return db.transaction(() => {
    assertSchema(db);
    if (op.operation === "review-inventory") {
      return { state: "INVENTORY", ...readReviewedInventory(db, readReviewedBinding(db, op.customerId)) };
    }
    const prepared = prepare(context, op);
    return { state: "DRY_RUN", requestId: op.plan.requestId, planVersion: op.plan.version, planSha256: prepared.planSha256, ...prepared.inventory };
  })();
}

export function readReviewedStatus(db: Database.Database, proof: VerifiedErasureLedger, requestId: string) {
  assertSchema(db);
  const entry = proof.bundle.entries.find(row => row.body.requestId === requestId);
  if (!entry || entry.body.kind !== "REVIEWED_ERASURE") erasurePlanRefused("ERASURE_REQUEST_NOT_REMOTE_CONFIRMED");
  const { reviewed } = entry.body;
  const receipt = reviewedReceipt(db, { ...entry, body: entry.body });
  return {
    requestId, state: receipt ? "ERASURE_APPLIED" : "REMOTE_CONFIRMED_APPLICATION_PENDING",
    sequence: entry.body.sequence, entrySha256: entry.hash, planVersion: reviewed.plan.version,
    planSha256: reviewed.planSha256, packageE: reviewed.plan.packageE, operatorId: reviewed.operatorId,
    approvedAt: reviewed.approvedAt, custodyRecordedAt: entry.body.recordedAt,
    categories: reviewed.plan.categories, receipt,
    processorDeletion: "PENDING", archiveDisposition: "PENDING",
  };
}

export async function executeReviewedErasure(context: Context & {
  fence: ErasureRuntimeFence; custodian: ErasureCustodian; journal: ErasureLedgerStore;
  readCurrent: (bundle?: ErasureBundle) => Promise<VerifiedErasureLedger>;
  publishReadMirror: (proof: VerifiedErasureLedger, drain: DrainedErasureRuntime) => Promise<void>;
}, op: ReviewExecution) {
  const { db, scope, keys, now, fence, custodian, journal, readCurrent } = context;
  const { plan, approval } = op;
  const find = () => journal.export().entries.find(row => row.body.requestId === plan.requestId);
  // Rejected first attempts leave the fence untouched. Recheck authority and scope while drained.
  assertSchema(db);
  if (!find()) prepare(context, op);
  return await fence.withReviewedDrain(db, async drain => {
    const existing = find();
    if (existing) {
      const { body } = existing;
      if (body.kind !== "REVIEWED_ERASURE" || body.reviewed.operatorId !== approval.operatorId ||
        body.reviewed.approvedAt !== approval.approvedAt || body.reviewed.planSha256 !== approval.planSha256 ||
        body.reviewed.approvalSha256 !== reviewedApprovalHash(approval) ||
        body.reviewed.planSha256 !== reviewedErasurePlanHash(plan, body.subject) ||
        erasurePseudonym(keys, body.subject.keyId, scope, "customer", op.customerId) !== body.subject.customer) {
        erasurePlanRefused("ERASURE_REQUEST_CONFLICT");
      }
      // GET first. Avoid a second write after an uncertain ACK. Reconciliation
      // of a confirmed entry is also available as a standalone owner operation.
      try { await custodian.reconcile(plan.requestId, randomBytes(32).toString("hex"), now()); } catch (error) {
        if (!(error instanceof Error) || error.message !== "ERASURE_LOCAL_LEDGER_STALE_OR_FORKED") throw error;
        const bundle = journal.export();
        if (bundle.entries.at(-1)?.hash !== existing.hash) erasurePlanRefused("ERASURE_REQUEST_CONFLICT");
        const prefix = await readCurrent({ ...bundle, entries: bundle.entries.slice(0, -1) });
        fence.assertCurrentPrefix(drain, prefix);
        const prepared = prepare(context, op);
        if (prepared.planSha256 !== body.reviewed.planSha256) erasurePlanRefused("ERASURE_REQUEST_CONFLICT");
        await custodian.publishPending(now(), existing.hash);
      }
    } else {
      const proof = await readCurrent();
      fence.assertCurrentPrefix(drain, proof, true);
      const prepared = prepare(context, op);
      // Existing full/partial requests freeze the old account. New case IDs
      // cannot silently supersede an earlier reviewed disposition.
      if (proof.bundle.entries.some(row => row.body.kind !== "MARKETING_SUPPRESSION" &&
        erasurePseudonym(keys, row.body.subject.keyId, scope, "customer", op.customerId) === row.body.subject.customer)) {
        erasurePlanRefused("ERASURE_SUBJECT_ALREADY_PLANNED");
      }
      const entry = journal.append({ requestId: plan.requestId, kind: "REVIEWED_ERASURE", subject: prepared.subject,
        reviewed: { plan, planSha256: prepared.planSha256, operatorId: approval.operatorId,
          approvedAt: approval.approvedAt, approvalSha256: reviewedApprovalHash(approval) } }, now());
      await custodian.publishPending(now(), entry.hash);
    }
    const proof = await readCurrent();
    fence.assertCurrentPrefix(drain, proof);
    await context.publishReadMirror(proof, drain);
    const applied = applyDrainedRuntimeErasure(db, proof, keys, scope, drain, now());
    const receipt = readReviewedStatus(db, proof, plan.requestId);
    if (!receipt.receipt) erasurePlanRefused("ERASURE_REVIEWED_RECEIPT_MISSING");
    await fence.reopen(drain, proof, applied.application);
    return receipt;
  });
}
