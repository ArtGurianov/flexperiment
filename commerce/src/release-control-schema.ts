import { z } from "zod";
import { isReleaseExpectation } from "./release-expectation";

/**
 * Extracted from types.ts so an ordinary DTO edit there stops being classified
 * RELEASE_SEMANTICS merely by proximity. This file owns exactly the request
 * schema for release-control mutations - see
 * docs/release/DEPLOYMENT_INVARIANTS.md#known-imprecision-typests.
 */
const releaseHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const releaseExpectedSchema = z.object({
  source_commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  // Delegated, never re-derived: the DTO and release-control must agree on one
  // grammar or a form ends up supported by one layer and rejected by the other,
  // which is exactly what made inventory-sha256 unreachable over the wire.
  migration: z.string().refine(isReleaseExpectation, { message: "migration must be a canonical release expectation" }),
  legal_version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  legal_manifest_sha256: releaseHashSchema,
  legal_hashes: z.object({
    PUBLIC_OFFER: releaseHashSchema,
    PRIVACY_POLICY: releaseHashSchema,
    PD_CONSENT: releaseHashSchema,
    CHECKOUT_DISCLOSURE: releaseHashSchema,
  }).strict(),
}).strict();

export const releaseControlSchema = z.object({
  release_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  mode: z.enum(["CONTROLLED_CUTOVER", "ROLLING"]),
  expected: releaseExpectedSchema,
}).strict();

export const completeRollingSchema = z.object({
  release_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  mode: z.literal("ROLLING"),
  expected: releaseExpectedSchema,
}).strict();

/**
 * This is deliberately not a generic "clear ROLLING owner" request.  Q2 is
 * immutable incident evidence: only its exact held owner can be resolved,
 * only for the incident recorded by the failed Phase 10B controller, and its
 * old expectations are never changed.  The full replacement expectation is
 * included so the replacement's DORMANT predicate remains the same strict
 * predicate completeRolling() uses, rather than a source-only approximation.
 */
export const agentReferralsStrandedRollingSupersedeSchema = z.object({
  release_id: z.literal("agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f"),
  expected_old_source_commit: z.literal("2dc1a55a070a7e9e9ebcd52f46dff8d171da223e"),
  replacement_source_commit: z.string().regex(/^[a-f0-9]{40}$/),
  replacement_expected: releaseExpectedSchema,
  reason_code: z.literal("SURFACE_CONTRACT_UNAVAILABLE"),
  incident_run_id: z.literal("34027377689"),
}).strict();
