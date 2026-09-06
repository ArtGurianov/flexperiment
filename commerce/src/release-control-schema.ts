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
