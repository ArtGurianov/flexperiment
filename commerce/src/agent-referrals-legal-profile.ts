import type Database from "better-sqlite3";
import { id } from "./crypto";

/**
 * Agent Referrals immutable legal-profile revisions and their projection to
 * legacy agents.contractor_type.
 *
 * This is the ONE gated foundation function allowed to write
 * contractor_type = 'ORGANIZATION' (or, for that matter, any contractor_type
 * value on an agent already governed by this profile). It is not wired to
 * any HTTP route in PR3 - agentSchema/agentPatchSchema and the legacy
 * admin.post("/agents") / admin.patch("/agents/:id") surface stay exactly as
 * PR2 left them, two-valued, and remain the only thing a legacy caller can
 * reach.
 *
 * The four allowed / two rejected legal_form x tax_mode combinations are
 * enforced twice: here, before any write, and structurally by the combined
 * CHECK constraint on agent_referrals_legal_profile_revisions in
 * 0043_agent_referrals_foundation.sql. A bypass of this function still
 * cannot write a rejected combination or a projection inconsistent with it.
 */

export type LegalForm = "INDIVIDUAL" | "INDIVIDUAL_ENTREPRENEUR" | "LEGAL_ENTITY";
export type TaxMode = "NPD" | "OTHER";
export type ProjectedContractorType = "SELF_EMPLOYED" | "INDIVIDUAL_ENTREPRENEUR" | "ORGANIZATION";

/**
 * The exact matrix from the plan. SELF_EMPLOYED is Russian tax law's own
 * definition of "self-employed" (an individual taxed under NPD); an
 * individual entrepreneur projects to INDIVIDUAL_ENTREPRENEUR regardless of
 * tax mode, since the legacy field never distinguished tax mode; a legal
 * entity - only representable under OTHER, since NPD is individual-only in
 * Russian tax law - projects to ORGANIZATION, the value PR2 added
 * specifically to represent it.
 */
const PROJECTION: Readonly<Record<LegalForm, Partial<Record<TaxMode, ProjectedContractorType>>>> = {
  INDIVIDUAL: { NPD: "SELF_EMPLOYED" },
  INDIVIDUAL_ENTREPRENEUR: { NPD: "INDIVIDUAL_ENTREPRENEUR", OTHER: "INDIVIDUAL_ENTREPRENEUR" },
  LEGAL_ENTITY: { OTHER: "ORGANIZATION" },
};

export class AgentReferralsLegalProfileError extends Error {
  constructor(readonly code: string, readonly status = 422, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AgentReferralsLegalProfileRevision = {
  id: string;
  agent_id: string;
  revision: number;
  legal_form: LegalForm;
  tax_mode: TaxMode;
  projected_contractor_type: ProjectedContractorType;
  supersedes_revision_id: string | null;
  reason: string;
  created_at: string;
};

/** The latest (and only meaningful) revision for an agent - never a stored pointer. See the migration's comment for why. */
export const currentAgentReferralsLegalProfile = (db: Database.Database, agentId: string): AgentReferralsLegalProfileRevision | null =>
  (db.prepare(`SELECT id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, created_at
    FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY revision DESC LIMIT 1`).get(agentId) as
    AgentReferralsLegalProfileRevision | undefined) ?? null;

export const allAgentReferralsLegalProfileRevisions = (db: Database.Database, agentId: string): AgentReferralsLegalProfileRevision[] =>
  db.prepare(`SELECT id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, created_at
    FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY revision ASC`).all(agentId) as AgentReferralsLegalProfileRevision[];

export type ApplyAgentReferralsLegalProfileInput = {
  agent_id: string;
  legal_form: LegalForm;
  tax_mode: TaxMode;
  reason: string;
};

export type ApplyAgentReferralsLegalProfileResult = {
  revision_id: string;
  revision: number;
  projected_contractor_type: ProjectedContractorType;
  minted: boolean;
};

/**
 * Atomic: insert the new revision (if the semantic profile actually
 * changed) and project it onto agents.contractor_type in one transaction.
 * The rejected-combination check happens BEFORE the transaction opens, so a
 * rejection leaves no partial evidence of any kind.
 */
export const applyAgentReferralsLegalProfile = (
  db: Database.Database,
  input: ApplyAgentReferralsLegalProfileInput,
): ApplyAgentReferralsLegalProfileResult => {
  const projected = PROJECTION[input.legal_form]?.[input.tax_mode];
  if (!projected) {
    throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION", 422, `${input.legal_form}+${input.tax_mode}`);
  }

  const run = db.transaction((): ApplyAgentReferralsLegalProfileResult => {
    const current = currentAgentReferralsLegalProfile(db, input.agent_id);

    // Same semantic profile as already current: idempotent no-op, mints no
    // new revision and leaves agents.contractor_type untouched (it is
    // already correct).
    if (current && current.legal_form === input.legal_form && current.tax_mode === input.tax_mode) {
      return { revision_id: current.id, revision: current.revision, projected_contractor_type: current.projected_contractor_type, minted: false };
    }

    const nextRevision = (current?.revision ?? 0) + 1;
    const revisionId = id();
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, input.agent_id, nextRevision, input.legal_form, input.tax_mode, projected, current?.id ?? null, input.reason);

    // agent_id's FK already refuses an unknown agent when the revision insert
    // above runs, so this UPDATE only ever reaches an agent known to exist.
    db.prepare("UPDATE agents SET contractor_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(projected, input.agent_id);

    return { revision_id: revisionId, revision: nextRevision, projected_contractor_type: projected, minted: true };
  });
  return run.immediate();
};
