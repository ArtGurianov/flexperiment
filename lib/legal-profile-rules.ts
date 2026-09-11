/**
 * The one canonical statement of the Agent Referrals legal-profile shape:
 * which legal_form x tax_mode pairs exist, what each projects to, and which
 * requisites each legal_form carries.
 *
 * It lives in `lib/` (alongside city-catalog/money) rather than in
 * `commerce/src/` because BOTH sides need it and only one of them can run
 * Node: the domain imports it, and so do the admin and partner React forms,
 * which previously carried hand-maintained mirrors of these same tables with
 * "mirrors the backend" comments. Those mirrors were three copies of one
 * fact, and the copy a reader reaches first is not necessarily the one the
 * server enforces. This module has NO imports on purpose - anything that
 * pulls in `node:crypto` or `better-sqlite3` cannot be bundled for the
 * browser, which is exactly why the duplication existed.
 *
 * The database is the deliberate FOURTH representation and stays separate:
 * migrations must not become runtime-dependent on TypeScript. What keeps the
 * two honest is not a shared import but an exhaustive conformance test
 * (commerce/test/agent-referrals-legal-profile-conformance.test.ts), which
 * walks every cell of the tables below and proves the DB accepts exactly
 * what the domain accepts - so changing one side without the other fails
 * loudly instead of drifting.
 */

export const LEGAL_FORMS = ["INDIVIDUAL", "INDIVIDUAL_ENTREPRENEUR", "LEGAL_ENTITY"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const TAX_MODES = ["NPD", "OTHER"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const PROJECTED_CONTRACTOR_TYPES = ["SELF_EMPLOYED", "INDIVIDUAL_ENTREPRENEUR", "ORGANIZATION"] as const;
export type ProjectedContractorType = (typeof PROJECTED_CONTRACTOR_TYPES)[number];

/**
 * SELF_EMPLOYED is Russian tax law's own definition of "self-employed" (an
 * individual taxed under NPD); an individual entrepreneur projects to
 * INDIVIDUAL_ENTREPRENEUR regardless of tax mode, since the legacy field
 * never distinguished tax mode; a legal entity - only representable under
 * OTHER, since NPD is individual-only in Russian tax law - projects to
 * ORGANIZATION. A missing cell is a REJECTED combination, not an oversight:
 * INDIVIDUAL+OTHER and LEGAL_ENTITY+NPD are both absent deliberately.
 */
export const LEGAL_PROFILE_PROJECTION: Readonly<Record<LegalForm, Readonly<Partial<Record<TaxMode, ProjectedContractorType>>>>> = {
  INDIVIDUAL: { NPD: "SELF_EMPLOYED" },
  INDIVIDUAL_ENTREPRENEUR: { NPD: "INDIVIDUAL_ENTREPRENEUR", OTHER: "INDIVIDUAL_ENTREPRENEUR" },
  LEGAL_ENTITY: { OTHER: "ORGANIZATION" },
};

/**
 * Returns null for BOTH a legitimate-enum-but-rejected pairing
 * (INDIVIDUAL+OTHER) and a value outside the unions entirely (an unchecked
 * `as LegalForm` cast at an HTTP boundary, say) - plain object indexing does
 * not distinguish the two, and no caller needs it to.
 */
export const resolveProjectedContractorType = (legalForm: LegalForm, taxMode: TaxMode): ProjectedContractorType | null =>
  LEGAL_PROFILE_PROJECTION[legalForm]?.[taxMode] ?? null;

/** Derived from the projection table, never listed a second time: a form offering a tax mode the matrix rejects is a form that submits a guaranteed 422. */
export const taxModesForLegalForm = (legalForm: LegalForm): readonly TaxMode[] =>
  TAX_MODES.filter((taxMode) => LEGAL_PROFILE_PROJECTION[legalForm]?.[taxMode] !== undefined);

export const REQUISITE_FIELDS = ["opf", "short_name", "kpp", "registration_number", "legal_address"] as const;
export type RequisiteField = (typeof REQUISITE_FIELDS)[number];
export type RequisiteFieldRule = "REQUIRED" | "OPTIONAL" | "FORBIDDEN";

/**
 * The per-legal_form shape for every field EXCEPT full_name/inn, which are
 * REQUIRED for all three (their FORMAT varies by legal_form, not their
 * presence - see INN_LENGTH). FORBIDDEN is as load-bearing as REQUIRED: an
 * INDIVIDUAL carrying a КПП is not a harmless extra field, it is a row whose
 * legal_form and requisites disagree.
 */
export const REQUISITE_SHAPE: Readonly<Record<LegalForm, Readonly<Record<RequisiteField, RequisiteFieldRule>>>> = {
  INDIVIDUAL: { opf: "FORBIDDEN", short_name: "FORBIDDEN", kpp: "FORBIDDEN", registration_number: "FORBIDDEN", legal_address: "FORBIDDEN" },
  INDIVIDUAL_ENTREPRENEUR: { opf: "FORBIDDEN", short_name: "FORBIDDEN", kpp: "FORBIDDEN", registration_number: "REQUIRED", legal_address: "FORBIDDEN" },
  LEGAL_ENTITY: { opf: "REQUIRED", short_name: "OPTIONAL", kpp: "REQUIRED", registration_number: "REQUIRED", legal_address: "REQUIRED" },
};

export const requisiteRule = (legalForm: LegalForm, field: RequisiteField): RequisiteFieldRule => REQUISITE_SHAPE[legalForm][field];

/** ИНН: 10 digits for an organization, 12 for a natural person (an individual entrepreneur is a natural person). */
export const INN_LENGTH: Readonly<Record<LegalForm, number>> = { INDIVIDUAL: 12, INDIVIDUAL_ENTREPRENEUR: 12, LEGAL_ENTITY: 10 };
export const KPP_LENGTH = 9;
/** ОГРН is 13 digits, ОГРНИП is 15. Absent for INDIVIDUAL, which has no registration number at all. */
export const REGISTRATION_NUMBER_LENGTH: Readonly<Partial<Record<LegalForm, number>>> = { INDIVIDUAL_ENTREPRENEUR: 15, LEGAL_ENTITY: 13 };
