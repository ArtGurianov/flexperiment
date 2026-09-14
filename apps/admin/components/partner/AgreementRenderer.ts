/**
 * PR3 of the reissuance/evidence program: a semantic renderer over a
 * partner agreement projection - never the raw JSON.stringify(content)
 * dump this replaces. Pure and DOM-free on purpose (golden-tested on its
 * own output shape, not markup) so the presentation layer stays fully
 * refactorable, the same reason a rendered-snapshot hash was rejected for
 * the underlying evidence itself.
 *
 * The 15 framework-agreement clause keys are duplicated here deliberately,
 * the same way apps/admin/components/agents/Agents.tsx duplicates the
 * ProjectedContractorType union as CONTRACTOR_TYPE_LABELS: this is a
 * client-safe presentation layer and must not import commerce/src (which
 * pulls in node:crypto). The closed clause vocabulary itself is enforced
 * server-side by assertComplete() in agent-referrals-framework-delegation.ts;
 * this dictionary only supplies a human label for each of that fixed set.
 */

export const FRAMEWORK_AGREEMENT_CLAUSE_LABELS: Readonly<Record<string, string>> = {
  DISTRIBUTION_SERVICES_DIRECT: "Услуги по распространению оказываются напрямую",
  APPROVED_CREATIVE_ONLY: "Публикация только согласованных креативов",
  PERMITTED_CHANNELS_PER_POLICY: "Каналы распространения — только разрешённые политикой",
  REPEATED_MULTI_RESOURCE_PUBLICATION: "Повторная публикация на нескольких ресурсах допускается",
  MINIMUM_DISTRIBUTION_FACTS_FOR_ORD: "Минимальный набор фактов размещения для ОРД",
  NO_INDEPENDENT_CREATIVE_MODIFICATION: "Запрет самостоятельного изменения креатива",
  PROMO_PART_OF_APPROVED_CREATIVE: "Промокод — часть согласованного креатива",
  REMOVAL_BY_PUBLICATION_END: "Обязательное снятие публикации по окончании срока",
  PARTNER_LEVY_OBLIGATION: "Обязанность партнёра по уплате сборов",
  FLEXPERIMENT_DOES_NOT_WITHHOLD_LEVY: "Flexperiment не удерживает сборы",
  REWARD_BASED_ON_ATTRIBUTED_PURCHASES: "Вознаграждение — по атрибутированным покупкам",
  POSITIVE_REWARD_ONLY_AFTER_COMPLETION: "Положительное вознаграждение — только после завершения",
  ZERO_REWARD_NO_OBLIGATION: "Нулевое вознаграждение не создаёт обязательств",
  ORD_SUBMISSION_DELEGATED: "Подача сведений в ОРД делегирована",
  REPORTING_TAIL_SURVIVES_CLOSURE_AND_REVOCATION: "Отчётный хвост сохраняется после закрытия и отзыва",
};

/** The plan's own ordered key list - order is part of the contract (never Object.keys of the content_json, which carries no ordering guarantee once round-tripped through JSON). */
export const FRAMEWORK_AGREEMENT_CLAUSE_ORDER: readonly string[] = [
  "DISTRIBUTION_SERVICES_DIRECT", "APPROVED_CREATIVE_ONLY", "PERMITTED_CHANNELS_PER_POLICY", "REPEATED_MULTI_RESOURCE_PUBLICATION",
  "MINIMUM_DISTRIBUTION_FACTS_FOR_ORD", "NO_INDEPENDENT_CREATIVE_MODIFICATION", "PROMO_PART_OF_APPROVED_CREATIVE", "REMOVAL_BY_PUBLICATION_END",
  "PARTNER_LEVY_OBLIGATION", "FLEXPERIMENT_DOES_NOT_WITHHOLD_LEVY", "REWARD_BASED_ON_ATTRIBUTED_PURCHASES", "POSITIVE_REWARD_ONLY_AFTER_COMPLETION",
  "ZERO_REWARD_NO_OBLIGATION", "ORD_SUBMISSION_DELEGATED", "REPORTING_TAIL_SURVIVES_CLOSURE_AND_REVOCATION",
];

export const DELEGATION_TEMPLATE_CLAUSE_ORDER: readonly string[] = ["ORD_SUBMISSION_DELEGATED", "REPORTING_TAIL_SURVIVES_CLOSURE_AND_REVOCATION"];

export type AgreementLegalProfileLike = {
  legal_form: string; tax_mode: string;
  opf: string | null; full_name: string; short_name: string | null; inn: string; kpp: string | null; registration_number: string | null; legal_address: string | null;
  revision: number;
};

/** Only displayed agreement-party facts belong in this comparison. IDs,
 * revisions, timestamps, derived contractor type, and provenance are not
 * legal requisites and must not manufacture a client-side divergence. */
const AGREEMENT_PARTY_FACTS = [
  "legal_form", "tax_mode", "opf", "full_name", "short_name", "inn", "kpp", "registration_number", "legal_address",
] as const;

export const sameAgreementPartyFacts = (a: AgreementLegalProfileLike, b: AgreementLegalProfileLike): boolean =>
  AGREEMENT_PARTY_FACTS.every((field) => a[field] === b[field]);

export type AgreementClauseView = { key: string; label: string; text: string };

export type AgreementPartyView = {
  full_name: string; short_name: string | null; inn: string; kpp: string | null;
  registration_number: string | null; legal_address: string | null; opf: string | null;
  legal_form: string; tax_mode: string; legal_profile_revision: number;
};

export type AgreementEvidenceView = {
  issuance_sequence: number;
  framework_agreement_revision: number;
  framework_agreement_content_hash: string;
  delegation_template_revision: number;
  delegation_template_content_hash: string;
  legal_profile_revision: number;
  issued_at: string;
  accepted_at: string | null;
};

export type AgreementSemanticView = {
  /** Whether this is the historically-accepted document (party = accepted_legal_profile) or the unaccepted current offer (party = current MAX profile). */
  historical: boolean;
  party: AgreementPartyView;
  framework_clauses: AgreementClauseView[];
  delegation_clauses: AgreementClauseView[];
  evidence: AgreementEvidenceView;
  /** NOTICE_ONLY divergence since acceptance - shown as a notice on a CURRENT agreement, never a status change. Always null for an unaccepted document. */
  noticeOnlyProfileDivergence: boolean;
};

const clauseTextOf = (contentJson: unknown, key: string): string => {
  const clauses = (contentJson as { clauses?: unknown })?.clauses;
  if (!Array.isArray(clauses)) return "";
  const found = clauses.find((entry) => Array.isArray(entry) && entry[0] === key);
  return found && typeof found[1] === "string" ? found[1] : "";
};

const partyOf = (profile: AgreementLegalProfileLike): AgreementPartyView => ({
  full_name: profile.full_name, short_name: profile.short_name, inn: profile.inn, kpp: profile.kpp,
  registration_number: profile.registration_number, legal_address: profile.legal_address, opf: profile.opf,
  legal_form: profile.legal_form, tax_mode: profile.tax_mode, legal_profile_revision: profile.revision,
});

export type BuildAgreementSemanticViewInput = {
  issuance_sequence: number;
  issued_at: string;
  framework_agreement: { revision: number; content_hash: string; content: unknown };
  delegation_template: { revision: number; content_hash: string; content: unknown };
  accepted: boolean;
  accepted_at: string | null;
  /** Unaccepted -> current MAX profile; accepted -> the historically-pinned accepted_legal_profile. Never swapped. */
  party_profile: AgreementLegalProfileLike;
  /** Only meaningful when accepted: whether the CURRENT profile has since diverged from the accepted one by a NOTICE_ONLY (non-contractual) change. */
  notice_only_divergence_since_acceptance: boolean;
};

/** The one function every Agreement.tsx render path (unaccepted / accepted-current) and its golden test go through. */
export const buildAgreementSemanticView = (input: BuildAgreementSemanticViewInput): AgreementSemanticView => ({
  historical: input.accepted,
  party: partyOf(input.party_profile),
  framework_clauses: FRAMEWORK_AGREEMENT_CLAUSE_ORDER.map((key) => ({ key, label: FRAMEWORK_AGREEMENT_CLAUSE_LABELS[key]!, text: clauseTextOf(input.framework_agreement.content, key) })),
  delegation_clauses: DELEGATION_TEMPLATE_CLAUSE_ORDER.map((key) => ({ key, label: FRAMEWORK_AGREEMENT_CLAUSE_LABELS[key]!, text: clauseTextOf(input.delegation_template.content, key) })),
  evidence: {
    issuance_sequence: input.issuance_sequence,
    framework_agreement_revision: input.framework_agreement.revision, framework_agreement_content_hash: input.framework_agreement.content_hash,
    delegation_template_revision: input.delegation_template.revision, delegation_template_content_hash: input.delegation_template.content_hash,
    legal_profile_revision: input.party_profile.revision,
    issued_at: input.issued_at, accepted_at: input.accepted_at,
  },
  noticeOnlyProfileDivergence: input.accepted && input.notice_only_divergence_since_acceptance,
});
