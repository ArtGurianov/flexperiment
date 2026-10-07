import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ControlRoomRefundCase, RefundCasesResponse, RefundDecisionCommand } from "@flexperiment/control-room-contracts";
import type { AcceptedRefund, PaymentRail, RefundSubmission } from "./checkout";
import { revokeEntitlementForOrderLine } from "./entitlements";
import { openRefundEnvelope, sealRefundEnvelope, type RefundEnvelope, type RefundEnvelopeKeyring } from "./refund-envelope";

export type RefundReason = "CUSTOMER_REQUEST" | "PRODUCT_WITHDRAWN" | "OCCURRENCE_CHANGED" | "OTHER";
export type RefundDecisionInput = RefundDecisionCommand;

type RequestContext = {
  request_id: string;
  request_public_id: string;
  request_state: string;
  order_line_id: string;
  order_id: string;
  order_public_id: string;
  unit_amount_kopecks: number;
  customer_id: string;
  email_normalized: string;
  refref_attempt_id: string | null;
  line_ref: string;
  fiscal_item_json: string;
};

const cleanRequired = (value: string, code: string) => {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(code);
  return cleaned;
};

export function recordCourseAccessStart(
  db: Database.Database,
  input: { customerId: string; courseRef: string; lessonRef: string },
  now = new Date().toISOString(),
) {
  db.prepare(`INSERT INTO course_access_starts(customer_id,course_ref,first_lesson_ref,first_accessed_at)
    VALUES (?,?,?,?) ON CONFLICT(customer_id,course_ref) DO NOTHING`)
    .run(input.customerId, input.courseRef, input.lessonRef, now);
}

export function requestRefund(
  db: Database.Database,
  input: { customerId: string; orderPublicId: string; idempotencyKey: string; reasonCode: RefundReason; customerNote?: string },
  now = new Date().toISOString(),
) {
  const idempotencyKey = cleanRequired(input.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED");
  const existing = db.prepare(`SELECT request.public_id AS requestPublicId,request.state,orders.public_id AS orderPublicId,request.customer_id AS customerId,
      request.reason_code AS reasonCode,request.customer_note AS customerNote
    FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
    WHERE request.idempotency_key=?`).get(idempotencyKey) as {
      requestPublicId: string; state: string; orderPublicId: string; customerId: string; reasonCode: RefundReason; customerNote: string | null;
    } | undefined;
  const validReasons: RefundReason[] = ["CUSTOMER_REQUEST", "PRODUCT_WITHDRAWN", "OCCURRENCE_CHANGED", "OTHER"];
  if (!validReasons.includes(input.reasonCode)) throw new Error("REFUND_REASON_INVALID");
  const customerNote = input.customerNote?.trim() || null;
  if (customerNote && customerNote.length > 2000) throw new Error("REFUND_NOTE_TOO_LONG");
  if (existing) {
    if (existing.customerId !== input.customerId || existing.orderPublicId !== input.orderPublicId
      || existing.reasonCode !== input.reasonCode || existing.customerNote !== customerNote) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return { requestPublicId: existing.requestPublicId, state: existing.state };
  }
  const row = db.prepare(`SELECT orders.id AS order_id,line.id AS line_id,line.unit_amount_kopecks,product.kind,product.product_ref,
      product.course_ref,orders.created_at AS ordered_at,access.first_accessed_at
    FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    LEFT JOIN course_access_starts access ON access.customer_id=orders.customer_id AND access.course_ref=product.course_ref
    WHERE orders.public_id=? AND orders.customer_id=? AND orders.state='FULFILLED'`)
    .get(input.orderPublicId, input.customerId) as {
      order_id: string; line_id: string; unit_amount_kopecks: number; kind: string; product_ref: string;
      course_ref: string | null; ordered_at: string; first_accessed_at: string | null;
    } | undefined;
  if (!row) throw new Error("REFUND_REQUEST_NOT_AVAILABLE");
  const open = db.prepare(`SELECT 1 FROM refund_requests WHERE order_line_id=?
    AND state IN ('REQUESTED','APPROVED','EXECUTING','REVIEW_REQUIRED')`).get(row.line_id);
  if (open) throw new Error("REFUND_REQUEST_ALREADY_OPEN");
  const publicId = randomUUID();
  const facts = {
    schema: "flexperiment.refund-policy-facts/1",
    productKind: row.kind,
    productRef: row.product_ref,
    courseRef: row.course_ref,
    paidLineAmountKopecks: row.unit_amount_kopecks,
    orderedAt: row.ordered_at,
    courseAccessStartedAt: row.first_accessed_at,
    requestedAt: now,
    automatedEligibility: "NOT_EVALUATED",
  };
  db.prepare(`INSERT INTO refund_requests
    (id,public_id,idempotency_key,customer_id,order_line_id,reason_code,customer_note,policy_facts_json,state,requested_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'REQUESTED',?,?)`)
    .run(randomUUID(), publicId, idempotencyKey, input.customerId, row.line_id, input.reasonCode, customerNote, JSON.stringify(facts), now, now);
  return { requestPublicId: publicId, state: "REQUESTED" as const };
}

const successfulRefundedAmount = (db: Database.Database, orderLineId: string) =>
  (db.prepare(`SELECT COALESCE(SUM(decision.amount_kopecks),0) AS amount
    FROM refund_requests request JOIN refund_decisions decision ON decision.refund_request_id=request.id
    JOIN refund_executions execution ON execution.refund_request_id=request.id AND execution.state='SUCCEEDED'
    WHERE request.order_line_id=? AND decision.outcome='APPROVE'`).get(orderLineId) as { amount: number }).amount;

export function decideRefund(
  db: Database.Database,
  requestPublicId: string,
  input: RefundDecisionInput,
  now = new Date().toISOString(),
) {
  const policyBasis = cleanRequired(input.policyBasis, "REFUND_POLICY_BASIS_REQUIRED");
  const rationale = cleanRequired(input.rationale, "REFUND_RATIONALE_REQUIRED");
  const actor = cleanRequired(input.actor, "REFUND_ACTOR_REQUIRED");
  const row = db.prepare(`SELECT request.id,request.state,request.order_line_id,line.unit_amount_kopecks
    FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id WHERE request.public_id=?`)
    .get(requestPublicId) as { id: string; state: string; order_line_id: string; unit_amount_kopecks: number } | undefined;
  if (!row) throw new Error("REFUND_REQUEST_NOT_FOUND");
  if (row.state !== "REQUESTED") throw new Error("REFUND_REQUEST_ALREADY_DECIDED");
  const amount = input.outcome === "APPROVE" ? input.amountKopecks : undefined;
  if (input.outcome === "APPROVE") {
    const remaining = row.unit_amount_kopecks - successfulRefundedAmount(db, row.order_line_id);
    if (!Number.isSafeInteger(amount) || amount! <= 0 || amount! > remaining) throw new Error("REFUND_AMOUNT_INVALID");
    // Full refunds only (ART-174): the whole line, nothing refunded before. A partial is not executable on
    // Flexperiment's rail, so it is not approvable either.
    if (amount !== row.unit_amount_kopecks || remaining !== row.unit_amount_kopecks) throw new Error("REFUND_FULL_ONLY");
  } else if (input.outcome !== "REJECT") throw new Error("REFUND_DECISION_INVALID");
  else if (input.amountKopecks !== undefined) throw new Error("REFUND_AMOUNT_INVALID");
  const apply = db.transaction(() => {
    db.prepare(`INSERT INTO refund_decisions(id,refund_request_id,outcome,amount_kopecks,policy_basis,rationale,decided_by,decided_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), row.id, input.outcome, amount ?? null, policyBasis, rationale, actor, now);
    db.prepare("UPDATE refund_requests SET state=?,updated_at=? WHERE id=? AND state='REQUESTED'")
      .run(input.outcome === "APPROVE" ? "APPROVED" : "REJECTED", now, row.id);
  });
  apply.immediate();
  return { requestPublicId, state: input.outcome === "APPROVE" ? "APPROVED" as const : "REJECTED" as const, amountKopecks: amount ?? null };
}

const requestContext = (db: Database.Database, publicId: string) => db.prepare(`SELECT request.id AS request_id,request.public_id AS request_public_id,
    request.state AS request_state,request.order_line_id,orders.id AS order_id,orders.public_id AS order_public_id,line.unit_amount_kopecks,
    orders.customer_id,customer.email_normalized,attempt.refref_attempt_id,line.id AS line_ref,line.fiscal_item_json
  FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
  JOIN customers customer ON customer.id=orders.customer_id JOIN checkout_attempts attempt ON attempt.order_id=orders.id
  WHERE request.public_id=?`).get(publicId) as RequestContext | undefined;

type ExecutionRow = {
  id: string; state: string; provider_execution_id: string | null; support_reference: string | null;
  request_envelope: string | null; envelope_key_id: string | null; refref_payment_id: string | null; amount_kopecks: number | null;
};
const executionOf = (db: Database.Database, requestId: string) => db.prepare(`SELECT id,state,provider_execution_id,support_reference,
  request_envelope,envelope_key_id,refref_payment_id,amount_kopecks FROM refund_executions WHERE refund_request_id=?`).get(requestId) as ExecutionRow | undefined;

/** Refref's REFUND_FAILED codes: a refusal it proved terminal — the request is done with, and so is its envelope. */
const PROVEN_REFUSALS = new Set(["REFUND_DECLINED", "REFUND_REJECTED", "REFUND_UNAVAILABLE"]);

/**
 * The sealed envelope holds the customer's receipt e-mail: deleted once the resolution is confirmed
 * terminal (0019), never while anything is uncertain — it is then the only way to replay.
 */
function purgeEnvelope(db: Database.Database, requestId: string, now: string) {
  db.prepare(`UPDATE refund_executions SET request_envelope=NULL,envelope_purged_at=?,updated_at=?
    WHERE refund_request_id=? AND request_envelope IS NOT NULL`).run(now, now, requestId);
}

/** The end of a refund: Refref's accepted Refund, matched to this execution's payment and amount. Only here is access revoked. */
function finishRefund(db: Database.Database, context: RequestContext, refund: AcceptedRefund, submission: RefundSubmission, now: string) {
  const finish = db.transaction(() => {
    db.prepare(`UPDATE refund_executions SET state='SUCCEEDED',canonical_refund_id=?,provider_execution_id=COALESCE(?,provider_execution_id),
      support_reference=COALESCE(?,support_reference),observed_projection_json=?,last_error_code=NULL,updated_at=? WHERE refund_request_id=?`)
      .run(refund.id, submission.refundExecutionId ?? null, submission.supportReference ?? null, JSON.stringify({ submission, refund }), now, context.request_id);
    db.prepare("UPDATE refund_requests SET state='REFUNDED',updated_at=? WHERE id=?").run(now, context.request_id);
    purgeEnvelope(db, context.request_id, now);
    const refunded = successfulRefundedAmount(db, context.order_line_id);
    if (refunded >= context.unit_amount_kopecks) revokeEntitlementForOrderLine(db, context.order_line_id, "REFUNDED", now);
    const outstanding = (db.prepare(`SELECT COUNT(*) AS count FROM order_lines line WHERE line.order_id=? AND
      COALESCE((SELECT SUM(decision.amount_kopecks) FROM refund_requests request
        JOIN refund_decisions decision ON decision.refund_request_id=request.id AND decision.outcome='APPROVE'
        JOIN refund_executions execution ON execution.refund_request_id=request.id AND execution.state='SUCCEEDED'
        WHERE request.order_line_id=line.id),0) < line.unit_amount_kopecks`).get(context.order_id) as { count: number }).count;
    db.prepare("UPDATE orders SET state=?,updated_at=? WHERE id=?").run(outstanding === 0 ? "REFUNDED" : "FULFILLED", now, context.order_id);
    db.prepare("UPDATE checkout_attempts SET state=?,updated_at=? WHERE order_id=?")
      .run(outstanding === 0 ? "REFUNDED" : "PARTIALLY_REFUNDED", now, context.order_id);
  });
  finish.immediate();
}

function requireReview(db: Database.Database, context: RequestContext, submission: RefundSubmission | null, code: string, now: string) {
  // The refusal and purge must be one UPDATE: 0020 refuses even an intermediate sealed terminal row.
  // A review caused by uncertainty, mismatch or a thrown submission error is not proven terminal.
  const provenRefusal = submission?.status === "FAILED" && PROVEN_REFUSALS.has(code);
  const apply = db.transaction(() => {
    db.prepare(`UPDATE refund_executions SET state='REVIEW_REQUIRED',provider_execution_id=COALESCE(?,provider_execution_id),
      support_reference=COALESCE(?,support_reference),observed_projection_json=COALESCE(?,observed_projection_json),last_error_code=?,updated_at=?,
      request_envelope=CASE WHEN ? THEN NULL ELSE request_envelope END,
      envelope_purged_at=CASE WHEN ? AND request_envelope IS NOT NULL THEN ? ELSE envelope_purged_at END
      WHERE refund_request_id=?`).run(submission?.refundExecutionId ?? null, submission?.supportReference ?? null,
        submission ? JSON.stringify(submission) : null, code, now, provenRefusal ? 1 : 0, provenRefusal ? 1 : 0, now, context.request_id);
    db.prepare("UPDATE refund_requests SET state='REVIEW_REQUIRED',updated_at=? WHERE id=?").run(now, context.request_id);
    db.prepare("UPDATE orders SET state='REVIEW_REQUIRED',updated_at=? WHERE id=?").run(now, context.order_id);
    db.prepare("UPDATE checkout_attempts SET state='REVIEW_REQUIRED',updated_at=? WHERE order_id=?").run(now, context.order_id);
  });
  apply.immediate();
}

type ExecutionOutcome = "PROCESSING" | "SUCCEEDED" | "REVIEW_REQUIRED";

/**
 * What Refref answered, applied. FAILED is a proven refusal: a person decides, access stays. A named
 * canonical Refund is read back and must be this payment's, this amount, accepted — then, and only then,
 * the refund is finished and access revoked. Anything else stays in flight.
 */
async function applySubmission(db: Database.Database, rail: PaymentRail, context: RequestContext, envelope: RefundEnvelope,
  submission: RefundSubmission, now: string): Promise<ExecutionOutcome> {
  if (submission.status === "FAILED") {
    requireReview(db, context, submission, submission.failureCode ?? "REFUND_EXECUTION_FAILED", now);
    return "REVIEW_REQUIRED";
  }
  if (submission.status === "UNKNOWN") {
    db.prepare("UPDATE refund_executions SET last_error_code='REFUND_SUBMISSION_UNKNOWN',updated_at=? WHERE refund_request_id=?").run(now, context.request_id);
    return "PROCESSING";
  }
  db.prepare(`UPDATE refund_executions SET provider_execution_id=COALESCE(provider_execution_id,?),support_reference=COALESCE(?,support_reference),
    observed_projection_json=?,last_error_code=NULL,updated_at=? WHERE refund_request_id=?`)
    .run(submission.refundExecutionId ?? null, submission.supportReference ?? null, JSON.stringify(submission), now, context.request_id);
  if (!submission.canonicalRefundId) return "PROCESSING";
  const refund = await rail.readRefund(submission.canonicalRefundId);
  if (!refund) return "PROCESSING";
  if (refund.status !== "SUCCEEDED" || refund.paymentId !== envelope.paymentId || refund.amountKopecks !== envelope.amountKopecks) {
    requireReview(db, context, submission, "REFUND_FACT_MISMATCH", now);
    return "REVIEW_REQUIRED";
  }
  finishRefund(db, context, refund, submission, now);
  return "SUCCEEDED";
}

const outcomeOf = (state: string): ExecutionOutcome => (state === "SUCCEEDED" ? "SUCCEEDED" : state === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "PROCESSING");

export async function executeApprovedRefund(
  db: Database.Database,
  rail: PaymentRail,
  keyring: RefundEnvelopeKeyring,
  requestPublicId: string,
  now = new Date().toISOString(),
) {
  const context = requestContext(db, requestPublicId);
  if (!context?.refref_attempt_id) throw new Error("REFUND_EXECUTION_NOT_AVAILABLE");
  // Begun once: what follows a begun execution is the reconciliation sweep's, from its frozen envelope.
  const existing = executionOf(db, context.request_id);
  if (existing) return { requestPublicId, state: outcomeOf(existing.state), providerExecutionId: existing.provider_execution_id, supportReference: existing.support_reference };
  const decision = db.prepare("SELECT amount_kopecks FROM refund_decisions WHERE refund_request_id=? AND outcome='APPROVE'")
    .get(context.request_id) as { amount_kopecks: number } | undefined;
  if (!decision || !["APPROVED", "EXECUTING"].includes(context.request_state)) throw new Error("REFUND_APPROVAL_REQUIRED");
  if (decision.amount_kopecks !== context.unit_amount_kopecks || successfulRefundedAmount(db, context.order_line_id) !== 0) throw new Error("REFUND_FULL_ONLY");
  // The one request this execution will ever send, built and checked before anything is written.
  const envelope = await rail.prepareRefund({
    attemptId: context.refref_attempt_id,
    amountKopecks: decision.amount_kopecks,
    orderPublicId: context.order_public_id,
    idempotencyKey: `refund:${requestPublicId}`,
    customerEmail: context.email_normalized,
    lineRef: context.line_ref,
    fiscalItem: JSON.parse(context.fiscal_item_json),
  });
  const executionId = randomUUID();
  const sealed = sealRefundEnvelope(keyring, executionId, envelope);
  const begin = db.transaction(() => {
    db.prepare(`INSERT INTO refund_executions(id,refund_request_id,idempotency_key,state,refref_payment_id,amount_kopecks,request_envelope,
      envelope_key_id,created_at,updated_at) VALUES (?,?,?,'PROCESSING',?,?,?,?,?,?)`)
      .run(executionId, context.request_id, envelope.idempotencyKey, envelope.paymentId, envelope.amountKopecks, sealed.sealed, sealed.keyId, now, now);
    db.prepare("UPDATE refund_requests SET state='EXECUTING',updated_at=? WHERE id=? AND state='APPROVED'").run(now, context.request_id);
    db.prepare("UPDATE orders SET state='REFUND_PENDING',updated_at=? WHERE id=?").run(now, context.order_id);
    db.prepare("UPDATE checkout_attempts SET state='REFUND_PENDING',updated_at=? WHERE order_id=?").run(now, context.order_id);
  });
  begin.immediate();
  let submission: RefundSubmission;
  try {
    submission = await rail.submitRefund(envelope);
  } catch (error) {
    // Refref answered and refused the request itself (a conflict, a validation): a person decides.
    requireReview(db, context, null, error instanceof Error ? error.message : "REFUND_SUBMISSION_REFUSED", now);
    return { requestPublicId, state: "REVIEW_REQUIRED" as const, providerExecutionId: null, supportReference: null };
  }
  const state = await applySubmission(db, rail, context, envelope, submission, now);
  return {
    requestPublicId, state, providerExecutionId: submission.refundExecutionId ?? null, supportReference: submission.supportReference ?? null,
    ...(submission.status === "UNKNOWN" ? { outcomeUnknown: true } : {}),
  };
}

/**
 * The sweep: every execution in flight, from its frozen envelope. Without Refref's execution id the same
 * envelope is sent again (Refref replays it under its key); with it, the execution is read. Never a body
 * rebuilt, never a balance read as a refund. An execution without an envelope (from before ART-174)
 * goes to a person.
 */
export async function reconcilePendingRefunds(db: Database.Database, rail: PaymentRail, keyring: RefundEnvelopeKeyring, now = new Date().toISOString()) {
  const rows = db.prepare(`SELECT request.public_id FROM refund_requests request
    JOIN refund_executions execution ON execution.refund_request_id=request.id
    WHERE execution.state IN ('READY','PROCESSING') ORDER BY execution.updated_at LIMIT 100`).all() as Array<{ public_id: string }>;
  let reconciled = 0;
  let failed = 0;
  for (const row of rows) {
    const context = requestContext(db, row.public_id);
    const execution = context ? executionOf(db, context.request_id) : undefined;
    if (!context || !execution) { failed += 1; continue; }
    try {
      if (!execution.request_envelope || !execution.envelope_key_id) {
        requireReview(db, context, null, "REFUND_ENVELOPE_MISSING", now);
        reconciled += 1;
        continue;
      }
      const envelope = openRefundEnvelope(keyring, execution.envelope_key_id, execution.id, execution.request_envelope);
      const submission = execution.provider_execution_id
        ? await rail.readRefundExecution(execution.provider_execution_id)
        : await rail.submitRefund(envelope);
      await applySubmission(db, rail, context, envelope, submission, now);
      reconciled += 1;
    } catch (error) {
      db.prepare("UPDATE refund_executions SET last_error_code=?,updated_at=? WHERE refund_request_id=?")
        .run(error instanceof Error ? error.message : "REFUND_RECONCILE_FAILED", now, context.request_id);
      failed += 1;
    }
  }
  return { selected: rows.length, reconciled, failed };
}

export function listRefundCases(db: Database.Database, now = new Date().toISOString()): RefundCasesResponse {
  const rows = db.prepare(`SELECT request.public_id AS requestPublicId,orders.public_id AS orderPublicId,request.reason_code AS reasonCode,
    request.state,request.policy_facts_json AS policyFactsJson,request.requested_at AS requestedAt,
    decision.outcome,decision.amount_kopecks AS amountKopecks,decision.policy_basis AS policyBasis,
    decision.rationale,decision.decided_by AS decidedBy,decision.decided_at AS decidedAt,
    execution.state AS executionState,execution.provider_execution_id AS providerExecutionId,
    execution.support_reference AS supportReference,execution.last_error_code AS lastErrorCode
    FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
    LEFT JOIN refund_decisions decision ON decision.refund_request_id=request.id
    LEFT JOIN refund_executions execution ON execution.refund_request_id=request.id
    ORDER BY request.requested_at DESC`).all() as Array<Omit<ControlRoomRefundCase, "policyFacts"> & { policyFactsJson: string }>;
  return { generatedAt: now, refunds: rows.map(({ policyFactsJson, ...row }) => ({
    ...row,
    policyFacts: JSON.parse(policyFactsJson) as ControlRoomRefundCase["policyFacts"],
  })) };
}

export function listCustomerRefunds(db: Database.Database, customerId: string) {
  return db.prepare(`SELECT request.public_id AS requestPublicId,orders.public_id AS orderPublicId,request.reason_code AS reasonCode,
    request.state,request.requested_at AS requestedAt,decision.outcome,decision.amount_kopecks AS amountKopecks,
    execution.state AS executionState,execution.support_reference AS supportReference
    FROM refund_requests request JOIN order_lines line ON line.id=request.order_line_id JOIN orders ON orders.id=line.order_id
    LEFT JOIN refund_decisions decision ON decision.refund_request_id=request.id
    LEFT JOIN refund_executions execution ON execution.refund_request_id=request.id
    WHERE request.customer_id=? ORDER BY request.requested_at DESC`).all(customerId);
}
