import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ErasureCustodian } from "./erasure-custody";
import { erasurePseudonym, erasureSubject, reviewedCancellationReason, type ErasureBundle, type ErasureKeys, type ErasureLedgerStore, type VerifiedErasureLedger } from "./erasure-ledger";
import { type DrainedErasureRuntime, type ErasureRuntimeFence } from "./erasure-fence";
import { applyDrainedRuntimeErasure, assertReviewedRestoreSchema } from "./erasure-restore";
import { assertReviewedPolicy, erasurePlanRefused, reviewedApprovalHash, reviewedApprovalSchema, reviewedErasurePlanHash, reviewedPlanSchema } from "./erasure-plan";
import { checkNewReviewedTarget, readReviewedBinding, readReviewedInventory, reviewedReceipt } from "./erasure-reviewed-application";
import { hasTable } from "./my-session-storage";

const customerId = z.string().min(1).max(256);
const reviewedAction = { customerId, plan: reviewedPlanSchema };
export const reviewedReadOperations = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("review-inventory"), customerId }).strict(),
  z.object({ operation: z.literal("review-dry-run"), ...reviewedAction }).strict(),
  z.object({ operation: z.literal("review-status"), requestId: z.uuid() }).strict(),
  z.object({ operation: z.literal("review-attempt"), requestId: z.uuid() }).strict(),
]);
export const reviewedExecuteOperation = z.object({
  operation: z.literal("review-execute"), ...reviewedAction, approval: reviewedApprovalSchema,
}).strict();

export const reviewedCancelOperation = z.object({
  operation: z.literal("review-cancel-unpublished"), requestId: z.uuid(),
  entrySha256: z.string().regex(/^[a-f0-9]{64}$/), reason: reviewedCancellationReason,
}).strict();
type ReviewCancellation = z.infer<typeof reviewedCancelOperation>;
export type ReviewedExecutionBoundary = "LOCAL_APPEND" | "REMOTE_CONFIRMED" | "MERCHANT_COMMITTED";
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
  return { subject, planSha256, inventory: checkNewReviewedTarget(db, binding, input.plan) };
}

export function readReviewedErasure(context: Context, op: Extract<z.infer<typeof reviewedReadOperations>, { operation: "review-inventory" | "review-dry-run" }>) {
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

export function readReviewedAttempt(bundle: ErasureBundle, requestId: string) {
  const entry = bundle.entries.find(row => row.body.requestId === requestId);
  if (entry?.body.kind === "REVIEWED_CANCELLATION") {
    return { requestId, state: "LOCAL_CANCELLATION_REF", entrySha256: entry.body.canceled.entrySha256, cancellationSha256: entry.hash };
  }
  if (!entry || entry.body.kind !== "REVIEWED_ERASURE") erasurePlanRefused("ERASURE_REVIEWED_ATTEMPT_NOT_FOUND");
  return { requestId, state: "LOCAL_ATTEMPT", entrySha256: entry.hash, planSha256: entry.body.reviewed.planSha256,
    recordedAt: entry.body.recordedAt };
}

export function readReviewedStatus(db: Database.Database, proof: VerifiedErasureLedger, requestId: string) {
  assertSchema(db);
  const entry = proof.bundle.entries.find(row => row.body.requestId === requestId);
  if (entry?.body.kind === "REVIEWED_CANCELLATION") {
    return { requestId, state: "CANCELED_UNPUBLISHED", sequence: entry.body.sequence, entrySha256: entry.hash,
      canceled: entry.body.canceled };
  }
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

type ExecutionContext = Context & {
  fence: ErasureRuntimeFence; custodian: ErasureCustodian; journal: ErasureLedgerStore;
  readCurrent: (bundle?: ErasureBundle) => Promise<VerifiedErasureLedger>;
  publishReadMirror: (proof: VerifiedErasureLedger, drain: DrainedErasureRuntime) => Promise<void>;
  boundary?: (boundary: ReviewedExecutionBoundary) => void;
};

export async function executeReviewedErasure(context: ExecutionContext, op: ReviewExecution) {
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
      if (body.kind === "REVIEWED_CANCELLATION") erasurePlanRefused("ERASURE_REVIEWED_ATTEMPT_CANCELED");
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
        if (journal.reviewedCancellation(plan.requestId)) erasurePlanRefused("ERASURE_REVIEWED_CANCELLATION_PENDING");
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
      if (proof.bundle.entries.some(row => (row.body.kind === "ERASURE" || row.body.kind === "REVIEWED_ERASURE") &&
        erasurePseudonym(keys, row.body.subject.keyId, scope, "customer", op.customerId) === row.body.subject.customer)) {
        erasurePlanRefused("ERASURE_SUBJECT_ALREADY_PLANNED");
      }
      const entry = journal.append({ requestId: plan.requestId, kind: "REVIEWED_ERASURE", subject: prepared.subject,
        reviewed: { plan, planSha256: prepared.planSha256, operatorId: approval.operatorId,
          approvedAt: approval.approvedAt, approvalSha256: reviewedApprovalHash(approval) } }, now());
      context.boundary?.("LOCAL_APPEND");
      await custodian.publishPending(now(), entry.hash);
    }
    const proof = await readCurrent();
    fence.assertCurrentPrefix(drain, proof);
    context.boundary?.("REMOTE_CONFIRMED");
    await context.publishReadMirror(proof, drain);
    const applied = applyDrainedRuntimeErasure(db, proof, keys, scope, drain, now());
    context.boundary?.("MERCHANT_COMMITTED");
    const receipt = readReviewedStatus(db, proof, plan.requestId);
    if (!("receipt" in receipt) || !receipt.receipt) erasurePlanRefused("ERASURE_REVIEWED_RECEIPT_MISSING");
    await fence.reopen(drain, proof, applied.application);
    return receipt;
  });
}

export async function cancelUnpublishedReviewedErasure(context: ExecutionContext, op: ReviewCancellation) {
  const { db, scope, keys, now, fence, custodian, journal, readCurrent } = context;
  const { requestId, entrySha256, reason } = op;
  assertSchema(db);
  return fence.withReviewedDrain(db, async drain => {
    const bundle = journal.export();
    const existing = bundle.entries.find(entry => entry.body.requestId === requestId);
    if (existing?.body.kind === "REVIEWED_CANCELLATION") {
      if (existing.body.canceled.entrySha256 !== entrySha256 || existing.body.canceled.reason !== reason) {
        erasurePlanRefused("ERASURE_REQUEST_CONFLICT");
      }
      const proof = await readCurrent();
      fence.assertCurrentPrefix(drain, proof);
      await context.publishReadMirror(proof, drain);
      return { ...readReviewedStatus(db, proof, requestId), runtimeAdmission: "PENDING" };
    }
    const pending = bundle.entries.at(-1);
    if (!pending || pending.body.kind !== "REVIEWED_ERASURE" || pending.body.requestId !== requestId || pending.hash !== entrySha256) {
      erasurePlanRefused("ERASURE_CANCELLATION_PREFIX_MISMATCH");
    }
    const prefix = { ...bundle, entries: bundle.entries.slice(0, -1) };
    const verifyPrefix = async () => {
      const proof = await readCurrent(prefix);
      fence.assertCurrentPrefix(drain, proof);
      return proof;
    };
    let cancellation = journal.reviewedCancellation(requestId);
    if (!cancellation) {
      const proof = await verifyPrefix();
      if (reason === "LEGAL_HOLD") {
        const { subject, reviewed } = pending.body;
        const customer = (db.prepare("SELECT id FROM customers").all() as Array<{ id: string }>)
          .find(row => erasurePseudonym(keys, subject.keyId, scope, "customer", row.id) === subject.customer);
        if (!customer) erasurePlanRefused("ERASURE_REQUEST_UNVERIFIED");
        const binding = readReviewedBinding(db, customer.id);
        try {
          assertReviewedPolicy({ policy: context.readPolicy(), plan: reviewed.plan, subject, binding, keys, now: now() });
          erasurePlanRefused("ERASURE_CANCELLATION_REASON_INVALID");
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "ERASURE_LEGAL_HOLD") throw error;
        }
      }
      cancellation = journal.stageReviewedCancellation(proof, op, now());
    }
    if (cancellation.body.kind !== "REVIEWED_CANCELLATION" || cancellation.body.canceled.reason !== reason ||
      cancellation.body.canceled.entrySha256 !== entrySha256) erasurePlanRefused("ERASURE_REQUEST_CONFLICT");
    const candidate = { ...prefix, entries: [...prefix.entries, cancellation] };
    await custodian.publishReviewedCancellation(candidate, now(), async () => { await verifyPrefix(); });
    const proof = await readCurrent(candidate);
    fence.assertCurrentPrefix(drain, proof);
    journal.confirmReviewedCancellation(proof, requestId, now());
    await context.publishReadMirror(proof, drain);
    return { ...readReviewedStatus(db, proof, requestId), runtimeAdmission: "PENDING" };
  }, false);
}
