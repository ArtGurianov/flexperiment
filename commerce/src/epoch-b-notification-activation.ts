import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalLegalManifest, legalDocumentIds, parseLegalManifest, type LegalManifest } from "./legal-manifest";
import { parseUtcTimestamp } from "./utc-timestamp";
import { evaluateReopenGate, type ReleaseCompletion, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "./release-control";

/** Immutable predecessor. P is created only as its deterministic direct child. */
export const EPOCH_B_RUNTIME_R = "80e152259628719af20d363a76ed6b991d67482a";
export const EPOCH_B_PRE_B_LEGAL_VERSION = "2026-08-26.1";
export const EPOCH_B_LEGAL_VERSION = "2026-08-28.1";
export const EPOCH_B_RELEASE_ID = `epoch-b-notification-activation:${EPOCH_B_RUNTIME_R}`;
export const EPOCH_B_DRAFT_PATH = "commerce/legal/production-manifest.2026-08-28.1.draft.json";
export const EPOCH_B_CANONICAL_MANIFEST_SHA256 = "fb879a80c48a50c41694d83118e5f8004a4fec5fbf36f954b15f4b678f4efe02";
export const EPOCH_B_PRIVACY_SHA256 = "642d11458733e8c1e5bfb28d0cde7f917a276dfcb3e32dc52adc34fac6326339";
export const EPOCH_B_PD_CONSENT_SHA256 = "acdb8a31a846c1c697cfd977fb67f24e75d280ab72cb6fbce5bbf0146d4ba5b6";

const promotionPaths = [
  "commerce/legal/production-manifest.json",
  "public/legal/public-offer.md",
  "public/legal/privacy-policy.md",
  "public/legal/personal-data-consent.md",
  "public/legal/disclaimer.md",
  "certification.sh",
] as const;

const destinations: Record<(typeof legalDocumentIds)[number], string> = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const git = (args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) => {
  const result = spawnSync("git", args, { input: options.input, env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`EPOCH_B_GIT_FAILED:${args.join(" ")}:${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
  return Buffer.from(result.stdout ?? []);
};

const gitText = (args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}) => git(args, options).toString("utf8").trimEnd();
const gitObject = (commit: string, path: string) => git(["show", `${commit}:${path}`]);

export const canonicalEpochBPublishTime = (value: string): string | undefined => {
  if (value === "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP") return undefined;
  const parsed = parseUtcTimestamp(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString().replace(".000Z", "Z");
};

export type EpochBLegalDraft = { version: string; publish_time?: string; documents: Record<string, unknown> };

/** Parses only the literal reviewed B draft and binds its canonical legal identity. */
export const parseEpochBLegalDraft = (raw: string | Buffer): { raw: EpochBLegalDraft; manifest: LegalManifest } => {
  const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as EpochBLegalDraft;
  if (parsed.version !== EPOCH_B_LEGAL_VERSION) throw new Error("EPOCH_B_DRAFT_VERSION_MISMATCH");
  const manifest = parseLegalManifest(parsed);
  if (sha256(canonicalLegalManifest(manifest)) !== EPOCH_B_CANONICAL_MANIFEST_SHA256) throw new Error("EPOCH_B_DRAFT_CANONICAL_HASH_MISMATCH");
  if (manifest.documents.PRIVACY_POLICY.sha256 !== EPOCH_B_PRIVACY_SHA256 || manifest.documents.PD_CONSENT.sha256 !== EPOCH_B_PD_CONSENT_SHA256) throw new Error("EPOCH_B_DRAFT_NOTIFICATION_HASH_MISMATCH");
  return { raw: parsed, manifest };
};

const promotionCertification = (source: string, manifest: LegalManifest) => {
  const values: Array<[string, string]> = [
    ["EXPECTED_LEGAL_VERSION", EPOCH_B_LEGAL_VERSION],
    ["EXPECTED_PUBLIC_OFFER_SHA256", manifest.documents.PUBLIC_OFFER.sha256],
    ["EXPECTED_PRIVACY_POLICY_SHA256", manifest.documents.PRIVACY_POLICY.sha256],
    ["EXPECTED_PD_CONSENT_SHA256", manifest.documents.PD_CONSENT.sha256],
    ["EXPECTED_CHECKOUT_DISCLOSURE_SHA256", manifest.documents.CHECKOUT_DISCLOSURE.sha256],
  ];
  let output = source;
  for (const [name, value] of values) {
    const expression = new RegExp(`^${name}="\\$\\{${name}:-[^}]+\\}"$`, "m");
    if (!expression.test(output)) throw new Error(`EPOCH_B_CERTIFICATION_DEFAULT_MISSING:${name}`);
    output = output.replace(expression, `${name}="\${${name}:-${value}}"`);
  }
  return output;
};

const archivePath = (manifest: LegalManifest, id: (typeof legalDocumentIds)[number]) => {
  const url = new URL(manifest.documents[id].archive_url);
  if (url.origin !== "https://flexperiment.ru" || !url.pathname.startsWith("/legal/archive/")) throw new Error(`EPOCH_B_ARCHIVE_PATH_INVALID:${id}`);
  return `public${url.pathname}`;
};

const gitBlob = (value: string | Buffer) => gitText(["hash-object", "-w", "--stdin"], { input: value });

/**
 * Creates the promotion object with Git plumbing only. The controller runs
 * this code from main; no R/P file is imported or executed. Fixed identity
 * and durable effectiveAt make recovery reconstruct the exact same commit.
 */
export const createEpochBPromotionArtifact = (input: { base: string; effectiveAt: string }): string => {
  if (input.base !== EPOCH_B_RUNTIME_R) throw new Error("EPOCH_B_PROMOTION_BASE_MISMATCH");
  const publishTime = canonicalEpochBPublishTime(input.effectiveAt);
  if (!publishTime) throw new Error("EPOCH_B_DURABLE_PUBLISH_TIME_INVALID");
  const { raw, manifest } = parseEpochBLegalDraft(gitObject(input.base, EPOCH_B_DRAFT_PATH));
  const promoted = { ...raw, publish_time: publishTime };
  const indexDirectory = mkdtempSync(join(tmpdir(), "flexperiment-epoch-b-index-"));
  const index = join(indexDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(["read-tree", input.base], { env });
    const updates: Array<[string, string | Buffer]> = [
      ["commerce/legal/production-manifest.json", `${JSON.stringify(promoted, null, 2)}\n`],
      ["certification.sh", promotionCertification(gitObject(input.base, "certification.sh").toString("utf8"), manifest)],
    ];
    for (const id of legalDocumentIds) updates.push([destinations[id], gitObject(input.base, archivePath(manifest, id))]);
    for (const [path, value] of updates) git(["update-index", "--add", "--cacheinfo", `100644,${gitBlob(value)},${path}`], { env });
    const tree = gitText(["write-tree"], { env });
    const seconds = Math.floor(parseUtcTimestamp(input.effectiveAt) / 1000);
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Flexperiment Release Control",
      GIT_AUTHOR_EMAIL: "release-control@flexperiment.ru",
      GIT_COMMITTER_NAME: "Flexperiment Release Control",
      GIT_COMMITTER_EMAIL: "release-control@flexperiment.ru",
      GIT_AUTHOR_DATE: `@${seconds} +0000`,
      GIT_COMMITTER_DATE: `@${seconds} +0000`,
    };
    return gitText(["commit-tree", tree, "-p", input.base, "-m", `release: activate occurrence notifications ${EPOCH_B_LEGAL_VERSION}`], { env: commitEnv });
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
};

export const epochBPromotionArtifactReason = (sha: string, effectiveAt: string): string | undefined => {
  if (!/^[a-f0-9]{40}$/.test(sha)) return "EPOCH_B_PROMOTION_SHA_INVALID";
  const parents = gitText(["rev-list", "--parents", "-n", "1", sha]).split(/\s+/);
  if (parents.length !== 2 || parents[1] !== EPOCH_B_RUNTIME_R) return "EPOCH_B_PROMOTION_PARENT_MISMATCH";
  const publishTime = canonicalEpochBPublishTime(effectiveAt);
  if (!publishTime) return "EPOCH_B_DURABLE_PUBLISH_TIME_INVALID";
  if (createEpochBPromotionArtifact({ base: EPOCH_B_RUNTIME_R, effectiveAt }) !== sha) return "EPOCH_B_PROMOTION_NOT_DETERMINISTIC";
  const paths = gitText(["diff", "--name-only", EPOCH_B_RUNTIME_R, sha]).split("\n").filter(Boolean).sort();
  if (paths.some((path) => !(promotionPaths as readonly string[]).includes(path))) return "EPOCH_B_PROMOTION_CHANGED_SURFACE_UNEXPECTED";
  const { raw, manifest } = parseEpochBLegalDraft(gitObject(sha, "commerce/legal/production-manifest.json"));
  if (canonicalEpochBPublishTime(String(raw.publish_time ?? "")) !== publishTime) return "EPOCH_B_PROMOTION_PUBLISH_TIME_MISMATCH";
  for (const id of legalDocumentIds) if (sha256(gitObject(sha, destinations[id])) !== manifest.documents[id].sha256) return `EPOCH_B_PROMOTION_CURRENT_COPY_MISMATCH:${id}`;
  return undefined;
};

const completionMatches = (completion: ReleaseCompletion, request: ReleaseControlRequest) =>
  completion.complete && completion.expected !== null
  && completion.expected.source_commit === request.expected.source_commit
  && completion.expected.migration === request.expected.migration
  && completion.expected.legal_version === request.expected.legal_version
  && completion.expected.legal_manifest_sha256 === request.expected.legal_manifest_sha256
  && completion.expected.legal_hashes.PUBLIC_OFFER === request.expected.legal_hashes.PUBLIC_OFFER
  && completion.expected.legal_hashes.PRIVACY_POLICY === request.expected.legal_hashes.PRIVACY_POLICY
  && completion.expected.legal_hashes.PD_CONSENT === request.expected.legal_hashes.PD_CONSENT
  && completion.expected.legal_hashes.CHECKOUT_DISCLOSURE === request.expected.legal_hashes.CHECKOUT_DISCLOSURE;

const ownerMatches = (status: ReleaseControlStatus, request: ReleaseControlRequest) =>
  status.expected !== null && status.owner_release_id === request.release_id && status.owner_mode === request.mode
  && status.expected.source_commit === request.expected.source_commit
  && status.expected.migration === request.expected.migration
  && status.expected.legal_version === request.expected.legal_version
  && status.expected.legal_manifest_sha256 === request.expected.legal_manifest_sha256;

export type EpochBAction = "RELEASE_ALREADY_COMPLETE" | "ACQUIRE_AND_PAUSE" | "BIND_LEGAL_B" | "PUBLISH_LEGAL_B" | "PROMOTE_PUBLISHED_LEGAL" | "DEPLOY_OR_CONVERGE" | "READY_TO_COMPLETE" | "BLOCKED";

/** The durable-only Epoch B state machine; P is supplied only after it is re-derived from durable effectiveAt. */
export const reconcileEpochB = (input: {
  stage: "prepare" | "complete";
  requestR: ReleaseControlRequest;
  requestLegalB: ReleaseControlRequest;
  requestP?: ReleaseControlRequest;
  status: ReleaseControlStatus;
  epochARequest: ReleaseControlRequest;
  epochACompletion: ReleaseCompletion;
  epochBCompletion: ReleaseCompletion;
  runtime: ReleaseRuntimeEvidence;
  legal: { version: string | null; occurrenceNotificationsAvailable: boolean | null };
  pointer: string;
}): { action: EpochBAction; reason?: string } => {
  if (!completionMatches(input.epochACompletion, input.epochARequest)) return { action: "BLOCKED", reason: "EPOCH_B_EPOCH_A_NOT_COMPLETE" };
  if (input.epochBCompletion.complete) return input.requestP && completionMatches(input.epochBCompletion, input.requestP)
    ? { action: "RELEASE_ALREADY_COMPLETE" } : { action: "BLOCKED", reason: "EPOCH_B_COMPLETION_MISMATCH" };
  if (input.status.owner_release_id && input.status.owner_release_id !== input.requestR.release_id) return { action: "BLOCKED", reason: "EPOCH_B_FOREIGN_RELEASE_OWNER" };
  if (!input.status.owner_release_id) {
    if (input.status.sales_paused) return { action: "BLOCKED", reason: "EPOCH_B_PAUSED_WITHOUT_OWNER" };
    if (input.stage !== "prepare") return { action: "BLOCKED", reason: "EPOCH_B_COMPLETE_REQUIRES_PAUSED_OWNER" };
    if (input.pointer !== EPOCH_B_RUNTIME_R || input.legal.version !== EPOCH_B_PRE_B_LEGAL_VERSION || input.legal.occurrenceNotificationsAvailable !== false) return { action: "BLOCKED", reason: "EPOCH_B_FRESH_ADOPTION_FORBIDDEN" };
    return { action: "ACQUIRE_AND_PAUSE" };
  }
  if (!input.status.sales_paused) return { action: "BLOCKED", reason: "EPOCH_B_OWNER_NOT_PAUSED" };
  if (ownerMatches(input.status, input.requestR)) {
    if (input.pointer !== EPOCH_B_RUNTIME_R) return { action: "BLOCKED", reason: "EPOCH_B_R_EXPECTATIONS_POINTER_MISMATCH" };
    if (input.legal.version === EPOCH_B_PRE_B_LEGAL_VERSION && input.legal.occurrenceNotificationsAvailable === false) return input.stage === "prepare"
      ? { action: "BIND_LEGAL_B" } : { action: "BLOCKED", reason: "EPOCH_B_COMPLETE_BEFORE_PROMOTION" };
    return { action: "BLOCKED", reason: "EPOCH_B_R_EXPECTATIONS_STATE_MISMATCH" };
  }
  if (ownerMatches(input.status, input.requestLegalB)) {
    if (input.pointer !== EPOCH_B_RUNTIME_R) return { action: "BLOCKED", reason: "EPOCH_B_LEGAL_B_EXPECTATIONS_POINTER_MISMATCH" };
    if (input.legal.version === EPOCH_B_PRE_B_LEGAL_VERSION && input.legal.occurrenceNotificationsAvailable === false) return input.stage === "prepare"
      ? { action: "PUBLISH_LEGAL_B" } : { action: "BLOCKED", reason: "EPOCH_B_COMPLETE_BEFORE_PROMOTION" };
    if (input.legal.version === EPOCH_B_LEGAL_VERSION && input.legal.occurrenceNotificationsAvailable === false && input.requestP) return input.stage === "prepare"
      ? { action: "PROMOTE_PUBLISHED_LEGAL" } : { action: "BLOCKED", reason: "EPOCH_B_COMPLETE_BEFORE_PROMOTION" };
    return { action: "BLOCKED", reason: "EPOCH_B_LEGAL_B_EXPECTATIONS_STATE_MISMATCH" };
  }
  if (!input.requestP || !ownerMatches(input.status, input.requestP)) return { action: "BLOCKED", reason: "EPOCH_B_OWNER_EXPECTATIONS_MISMATCH" };
  if (input.legal.version !== EPOCH_B_LEGAL_VERSION) return { action: "BLOCKED", reason: "EPOCH_B_ACTIVE_LEGAL_VERSION_MISMATCH" };
  if (input.pointer === EPOCH_B_RUNTIME_R) return input.legal.occurrenceNotificationsAvailable === false
    ? { action: "DEPLOY_OR_CONVERGE" } : { action: "BLOCKED", reason: "EPOCH_B_PRE_CAS_CAPABILITY_UNEXPECTED" };
  if (input.pointer !== input.requestP.expected.source_commit) return { action: "BLOCKED", reason: "EPOCH_B_P_EXPECTATIONS_POINTER_MISMATCH" };
  if (input.legal.occurrenceNotificationsAvailable !== true) return { action: "DEPLOY_OR_CONVERGE" };
  return epochBActiveRuntimeReason(input.requestP, input.runtime, input.legal)
    ? { action: "DEPLOY_OR_CONVERGE" }
    : { action: "READY_TO_COMPLETE" };
};

export const epochBActiveRuntimeReason = (request: ReleaseControlRequest, runtime: ReleaseRuntimeEvidence, legal: { version: string | null; occurrenceNotificationsAvailable: boolean | null }) =>
  evaluateReopenGate(request, runtime)
  ?? (legal.version !== EPOCH_B_LEGAL_VERSION ? "EPOCH_B_PUBLIC_LEGAL_VERSION_MISMATCH" : undefined)
  ?? (legal.occurrenceNotificationsAvailable !== true ? "EPOCH_B_NOTIFICATION_CAPABILITY_NOT_ACTIVE" : undefined);
