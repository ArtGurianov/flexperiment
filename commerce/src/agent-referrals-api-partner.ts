import { Hono } from "hono";
import type Database from "better-sqlite3";
import { DomainError } from "./domain";
import { clientIpRateLimitKey, rateLimit } from "./rate-limit";
import { UnconfiguredOtpSender, issueAndDispatchOtpChallenge, loginWithOtp, type OtpSender } from "./agent-referrals-otp";
import { requestPartnerLoginByEmail } from "./agent-referrals-login";
import { consumePartnerInvite, submitPartnerLegalProfile } from "./agent-referrals-partner-identity";
import { acceptFrameworkAndDelegation } from "./agent-referrals-framework-acceptance";
import { revokeDelegationAsPartner } from "./agent-referrals-delegation-revocation";
import { assertPartnerOrigin, parsePartnerSessionToken, partnerSessionCookie, partnerSessionCookieCleared } from "./agent-referrals-partner-auth";
import { resolvePartnerSession, revokePartnerSession } from "./agent-referrals-partner-session";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";
import { mintStepUpGrant, type StepUpAction } from "./agent-referrals-step-up";
import { mintEngagementStepUpGrant, type EngagementStepUpAction } from "./agent-referrals-engagement-step-up";
import { mintSettlementStepUpGrant, type SettlementStepUpAction } from "./agent-referrals-settlement-step-up";
import { setPartnerPayoutDestination, revokePartnerPayoutDestination, type PayoutDestinationKind } from "./agent-referrals-payout-profile";
import { acceptEngagement } from "./agent-referrals-engagement";
import { reportDistribution, correctDistribution, claimRemoval, type ResourceKind } from "./agent-referrals-distribution";
import { acceptSettlementAct, disputeSettlementAct, type DocumentDisputeReason } from "./agent-referrals-act";
import { paymentAttemptById } from "./agent-referrals-payment";
import { agentReferralsSettlementById } from "./agent-referrals-settlement";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import {
  partnerProfileProjection, partnerAgreementsProjection, partnerEngagementSummaries, partnerEngagementDetail, partnerConversionProjection,
  PartnerProjectionError,
} from "./agent-referrals-partner-projection";

/**
 * `/v1/partner/*` - the entire HTTP surface for the PARTNER realm (Phase 9
 * amendment). A logically separate API surface from `/v1/admin/*`: no
 * handler in this file ever accepts a caller-supplied partner_identity_id,
 * agent_id or engagement_id as AUTHORITY - the partner_identity_id used by
 * every protected route below is resolved exclusively from the session
 * cookie (via resolvePartnerSession), and every read/write that names a
 * specific owned resource (an engagement, a distribution, an act, ...)
 * proves ownership independently (either inside the domain function itself
 * - acceptEngagement, correctDistribution, acceptSettlementAct, ... already
 * do this - or via agent-referrals-partner-projection.ts's own ownership
 * checks for reads that have no natural domain-layer owner check).
 *
 * Every response DTO comes from agent-referrals-partner-projection.ts's
 * explicit allowlist (§B-11) or from a domain module's own already-redacted
 * read model (currentPayoutProfile never selects ciphertext, ...) - this
 * file never serializes a raw admin-shaped row.
 */

type PartnerAppBindings = { Variables: { partner: PartnerPrincipal } };

const jsonBody = async (request: Request) => {
  try { return await request.json(); } catch { throw new DomainError("INVALID_JSON", 400); }
};
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const requireString = (body: Record<string, unknown>, field: string): string => {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new DomainError("AGENT_REFERRALS_PARTNER_FIELD_REQUIRED", 422, field);
  return value;
};
const optionalString = (body: Record<string, unknown>, field: string): string | undefined => {
  const value = body[field];
  return typeof value === "string" ? value : undefined;
};
const nullableString = (body: Record<string, unknown>, field: string): string | null => {
  const value = body[field];
  return typeof value === "string" ? value : null;
};

const distributionReportInput = (body: Record<string, unknown>) => ({
  channel_key: requireString(body, "channel_key"),
  resource_kind: requireString(body, "resource_kind") as ResourceKind,
  resource_identifier: requireString(body, "resource_identifier"),
  distribution_resource_url: requireString(body, "distribution_resource_url"),
  published_at: requireString(body, "published_at"),
  ended_at: nullableString(body, "ended_at"),
  evidence_ref: requireString(body, "evidence_ref"),
});

export function createAgentReferralsPartnerRouter(sqlite: Database.Database, otpSender: OtpSender = new UnconfiguredOtpSender()) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!assertPartnerOrigin(c.req.header("Origin"))) throw new DomainError("ORIGIN_FORBIDDEN", 403);
    c.header("Cache-Control", "no-store");
    await next();
  });

  // ---- Unauthenticated login surface. Its own Hono() sub-app, mounted
  // alongside (never inside) the session-protected sub-app below, so the
  // protected sub-app's own auth middleware structurally cannot apply to
  // it - mirrors api.ts's own publicApi/admin/releaseControl split, each a
  // separate Hono() instance with its own scoped middleware chain. --------
  const publicRouter = new Hono();

  publicRouter.post("/invite/consume", async (c) => {
    rateLimit(clientIpRateLimitKey("partner-invite-consume", c.req.raw.headers), 20, 10 * 60_000);
    const body = asRecord(await jsonBody(c.req.raw));
    const token = requireString(body, "token");
    const { partner_identity_id: partnerIdentityId } = consumePartnerInvite(sqlite, token);
    const { challenge_id: challengeId } = await issueAndDispatchOtpChallenge(sqlite, partnerIdentityId, otpSender);
    return c.json({ challenge_id: challengeId });
  });

  publicRouter.post("/login/request", async (c) => {
    rateLimit(clientIpRateLimitKey("partner-login-request-ip", c.req.raw.headers), 10, 10 * 60_000);
    const body = asRecord(await jsonBody(c.req.raw));
    const email = requireString(body, "email");
    rateLimit(`partner-login-request-email:${email.trim().toLowerCase()}`, 5, 30 * 60_000);
    // Identical response whether or not the email resolves to a live
    // identity - see agent-referrals-login.ts's own header. Never returns a
    // challenge_id here (that would itself be an enumeration oracle); the
    // partner reads the code from their inbox and calls /login/verify with
    // whichever challenge their email named.
    await requestPartnerLoginByEmail(sqlite, email, otpSender);
    return c.json({ ok: true });
  });

  publicRouter.post("/login/verify", async (c) => {
    rateLimit(clientIpRateLimitKey("partner-login-verify-ip", c.req.raw.headers), 20, 10 * 60_000);
    const body = asRecord(await jsonBody(c.req.raw));
    const challengeId = requireString(body, "challenge_id");
    const code = requireString(body, "code");
    rateLimit(`partner-login-verify-challenge:${challengeId}`, 8, 10 * 60_000);
    const result = loginWithOtp(sqlite, challengeId, code);
    c.header("Set-Cookie", partnerSessionCookie(result.raw_session_token, 12 * 60 * 60));
    return c.json({ ok: true });
  });

  // ---- Session-protected surface: its own Hono() sub-app. -----------------
  const protectedRouter = new Hono<PartnerAppBindings>();
  protectedRouter.use("*", async (c, next) => {
    const rawToken = parsePartnerSessionToken(c.req.header("Cookie"));
    const partner = rawToken ? resolvePartnerSession(sqlite, rawToken) : undefined;
    if (!partner) throw new DomainError("AGENT_REFERRALS_PARTNER_AUTH_REQUIRED", 401);
    rateLimit(`partner:${partner.partner_identity_id}`, 240, 60_000);
    c.set("partner", partner);
    await next();
  });

  protectedRouter.post("/logout", (c) => {
    revokePartnerSession(sqlite, c.var.partner);
    c.header("Set-Cookie", partnerSessionCookieCleared());
    return c.json({ ok: true });
  });

  protectedRouter.get("/me", (c) => c.json(partnerProfileProjection(sqlite, c.var.partner.partner_identity_id)));

  protectedRouter.post("/legal-profile", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const legalForm = requireString(body, "legal_form") as "INDIVIDUAL" | "INDIVIDUAL_ENTREPRENEUR" | "LEGAL_ENTITY";
    const taxMode = requireString(body, "tax_mode") as "NPD" | "OTHER";
    return c.json(submitPartnerLegalProfile(sqlite, c.var.partner, legalForm, taxMode));
  });

  protectedRouter.get("/agreements", (c) => c.json(partnerAgreementsProjection(sqlite, c.var.partner.partner_identity_id)));

  protectedRouter.post("/step-up", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const action = requireString(body, "action") as StepUpAction;
    return c.json(mintStepUpGrant(sqlite, c.var.partner, action, asRecord(body.resource)));
  });
  protectedRouter.post("/engagement-step-up", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const action = requireString(body, "action") as EngagementStepUpAction;
    return c.json(mintEngagementStepUpGrant(sqlite, c.var.partner, action, asRecord(body.resource)));
  });
  protectedRouter.post("/settlement-step-up", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const action = requireString(body, "action") as SettlementStepUpAction;
    return c.json(mintSettlementStepUpGrant(sqlite, c.var.partner, action, asRecord(body.resource)));
  });

  protectedRouter.post("/framework/accept", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const stepUpGrantId = requireString(body, "step_up_grant_id");
    const frameworkAgreementRevisionId = requireString(body, "framework_agreement_revision_id");
    const delegationTemplateRevisionId = requireString(body, "delegation_template_revision_id");
    return c.json(acceptFrameworkAndDelegation(sqlite, c.var.partner, stepUpGrantId, frameworkAgreementRevisionId, delegationTemplateRevisionId));
  });

  protectedRouter.post("/delegation/:id/revoke", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const stepUpGrantId = requireString(body, "step_up_grant_id");
    const reason = requireString(body, "reason");
    return c.json(revokeDelegationAsPartner(sqlite, c.var.partner, c.req.param("id"), stepUpGrantId, reason));
  });

  protectedRouter.get("/payout-profile", (c) => c.json(partnerProfileProjection(sqlite, c.var.partner.partner_identity_id).payout_profile));
  protectedRouter.post("/payout-profile", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(setPartnerPayoutDestination(sqlite, c.var.partner, {
      step_up_grant_id: requireString(body, "step_up_grant_id"),
      destination_kind: requireString(body, "destination_kind") as PayoutDestinationKind,
      destination_plaintext: requireString(body, "destination_plaintext"),
      destination_last4: requireString(body, "destination_last4"),
    }));
  });
  protectedRouter.post("/payout-profile/revoke", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(revokePartnerPayoutDestination(sqlite, c.var.partner, requireString(body, "step_up_grant_id")));
  });

  protectedRouter.get("/engagements", (c) => c.json({ engagements: partnerEngagementSummaries(sqlite, c.var.partner.partner_identity_id) }));
  protectedRouter.get("/engagements/:id", (c) => c.json(partnerEngagementDetail(sqlite, c.var.partner.partner_identity_id, c.req.param("id"))));
  protectedRouter.get("/engagements/:id/conversions", (c) => c.json({ conversions: partnerConversionProjection(sqlite, c.var.partner.partner_identity_id, c.req.param("id")) }));

  protectedRouter.post("/engagements/:id/accept", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(acceptEngagement(sqlite, c.var.partner, c.req.param("id"), requireString(body, "engagement_revision_id"), requireString(body, "step_up_grant_id")));
  });

  protectedRouter.post("/engagements/:id/distributions", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(reportDistribution(sqlite, c.var.partner, c.req.param("id"), distributionReportInput(body)), 201);
  });

  protectedRouter.post("/distributions/:id/correct", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(correctDistribution(sqlite, c.var.partner, c.req.param("id"), distributionReportInput(body), requireString(body, "correction_reason")));
  });

  protectedRouter.post("/distributions/:id/removal-claim", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    claimRemoval(sqlite, c.var.partner, c.req.param("id"), requireString(body, "evidence_ref"));
    return c.json({ ok: true });
  });

  protectedRouter.post("/acts/:id/accept", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(acceptSettlementAct(sqlite, c.var.partner, c.req.param("id"), requireString(body, "step_up_grant_id")));
  });
  protectedRouter.post("/acts/:id/dispute", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    return c.json(disputeSettlementAct(sqlite, c.var.partner, c.req.param("id"), requireString(body, "reason") as DocumentDisputeReason, optionalString(body, "detail")));
  });

  /**
   * §B-2: "submit NPD receipt evidence" - deliberately NOT a write to
   * npd_receipts (recordNpdReceipt takes only an AdminPrincipal; widening
   * it to accept a PartnerPrincipal would let a partner self-confirm their
   * own tax-authorization payout gate, which is exactly the operator
   * confirmation §B-6/Phase 7 requires). This records the partner's
   * evidence as a partner-realm audit event only - the operator reviews it
   * in the admin queue and, if it checks out, calls the real
   * recordNpdReceipt themselves. No new authority is created here.
   */
  protectedRouter.post("/npd-receipts/submit", async (c) => {
    const body = asRecord(await jsonBody(c.req.raw));
    const paymentAttemptId = requireString(body, "payment_attempt_id");
    const receiptReference = requireString(body, "receipt_reference");
    const evidenceRef = requireString(body, "evidence_ref");
    const attempt = paymentAttemptById(sqlite, paymentAttemptId);
    if (!attempt) throw new PartnerProjectionError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, paymentAttemptId);
    const settlement = agentReferralsSettlementById(sqlite, attempt.settlement_id);
    if (!settlement || settlement.partner_identity_id !== c.var.partner.partner_identity_id) {
      throw new PartnerProjectionError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, paymentAttemptId);
    }
    recordPartnerIdentityEvent(sqlite, c.var.partner.partner_identity_id, "NPD_RECEIPT_EVIDENCE_SUBMITTED_BY_PARTNER", "PARTNER", { payment_attempt_id: paymentAttemptId, receipt_reference: receiptReference, evidence_ref: evidenceRef });
    return c.json({ ok: true }, 201);
  });

  app.route("/", publicRouter);
  app.route("/", protectedRouter);
  return app;
}
