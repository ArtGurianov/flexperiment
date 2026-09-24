/**
 * Everything the production release runner needs, read once and validated
 * before a single adapter is constructed.
 *
 * It reports every missing piece at once. Discovering configuration one
 * variable per run means starting the runner repeatedly against production,
 * and each of those starts is a process that could take the lock, read the
 * pointer and begin a session before failing on the next absent field.
 *
 * Nothing here has a production default. A default is a guess about which
 * database, which remote or which Coolify application is the real one, and the
 * cost of guessing wrong is paid against production exactly once.
 */

import { parseCapabilityKeyring } from "../certification/nonce";

export class ReleaseConfigError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * How an application is deployed, stated here rather than discovered.
 *
 * Coolify reports a `build_pack`, and the destructive paths used to branch on
 * it directly. That made the runtime shape of production an input the control
 * plane learned at run time - and a test double that answered "dockerfile" for
 * everything left the Compose branches, which are the destructive ones,
 * outside the composition root's contract entirely. Two outages came through
 * that gap.
 *
 * So the kind is configuration. What Coolify reports is checked against it and
 * a disagreement is a refusal, never a branch.
 */
export type DeploymentKind = "dockerfile" | "dockercompose";

export type SurfaceApplicationConfig = {
  readonly name: string;
  readonly uuid: string;
  readonly deploymentKind: DeploymentKind;
  readonly surfaces: readonly ("frontend" | "admin" | "commerce" | "worker")[];
};

/**
 * What it takes to look at production and nothing more.
 *
 * It is a separate type, not a subset picked out at the call site, because the
 * read-only runner's safety comes from what it was built out of. A composition
 * that never receives a Coolify token, a write credential or an archive
 * directory cannot deploy, roll back, issue a capability or rename a database -
 * and that is a stronger statement than a flag inside a runner that could.
 */
export type CandidatePublicationConfig = {
  /** Published candidates, write-once. Read by the deploy, written by the publication. */
  readonly candidateDirectory: string;
  readonly deployRef: { readonly remote: string; readonly worktree: string };
};

export type PredecessorReleaseConfig = {
  readonly expectedSha: string;
  readonly expectedLedgerLength: number;
  readonly commerceReadyUrl: string;
};

export type ReadOnlyReleaseConfig = {
  readonly databasePath: string;
  /** Present only while observe is expected to read the one trusted legacy predecessor. */
  readonly predecessor?: PredecessorReleaseConfig;
  readonly topology: { readonly frontendReleaseUrl: string; readonly adminReleaseUrl: string };
  readonly deployRef: { readonly remote: string; readonly ref: string; readonly worktree: string };
};

export type ProductionReleaseConfig = {
  /** The live SQLite file the runner reads the release authority out of. */
  readonly databasePath: string;
  /** The DB/volume namespace replaced at bootstrap; it is never allowed to contain release state. */
  readonly replacementRoot: string;
  /** Runner-owned state outside replacementRoot, but deliberately on the same filesystem for atomic archives. */
  readonly stateDirectory: string;
  /** Where a predecessor database is archived to, and restored from. */
  readonly archiveDirectory: string;
  /** Survives the database being replaced and the containers being swapped. */
  readonly envelopeDirectory: string;
  /** One cutover at a time, enforced by the filesystem rather than by convention. */
  readonly lockPath: string;
  /** Append-only, secret-free record of what this run did. */
  readonly journalPath: string;
  /** Published candidates. The deploy reads them; it never writes one. */
  readonly candidateDirectory: string;
  /** Everything the attended certification needs. Its key never reaches a container. */
  readonly certification: {
    readonly adminBaseUrl: string;
    readonly publicBaseUrl: string;
    readonly serviceToken: string;
    readonly capabilityKey: string;
    readonly citySlug: string;
    readonly occurrenceScopePath: string;
    readonly checkoutBodyPath: string;
  };
  /**
   * The one predecessor a launch cutover may start from. Absent for every
   * ordinary release, which never crosses a lineage boundary.
   */
  readonly predecessor?: PredecessorReleaseConfig;
  readonly coolify: { readonly apiUrl: string; readonly token: string };
  /** Trusted repositories for the two local images in the commerce Compose application. */
  readonly composeRepositories: Readonly<Record<"commerce" | "commerce-worker", string>>;
  readonly applications: readonly SurfaceApplicationConfig[];
  readonly topology: { readonly frontendReleaseUrl: string; readonly adminReleaseUrl: string };
  readonly deployRef: { readonly remote: string; readonly ref: string; readonly worktree: string };
  /**
   * Where a forward revision's exact-SHA CI is read. Only `forward-deploy`
   * needs it, and it refuses without it; every other command runs as before.
   * The token file is optional because the repository is public.
   */
  readonly ciAttestation?: { readonly repository: string; readonly tokenFile?: string };
};

const UUID = /^[0-9a-zA-Z][0-9a-zA-Z._-]{7,63}$/;

/**
 * The three Coolify applications, and which of the four surfaces each one
 * serves. `commerce` carries its own worker in the same application, which is
 * why a surface list is not a single name: a topology of four is deployed by
 * three moving parts, and pretending otherwise would leave the worker
 * unaccounted for at exactly the moment convergence is judged.
 */
const APPLICATIONS: readonly { readonly variable: string; readonly name: string; readonly deploymentKind: DeploymentKind; readonly surfaces: SurfaceApplicationConfig["surfaces"] }[] = [
  { variable: "COOLIFY_APPLICATION_FRONTEND", name: "frontend", deploymentKind: "dockerfile", surfaces: ["frontend"] },
  { variable: "COOLIFY_APPLICATION_ADMIN", name: "admin", deploymentKind: "dockerfile", surfaces: ["admin"] },
  // Two services in one Compose application, which is why this one carries two
  // surfaces and why its recovery is local images rather than a Coolify image
  // rollback.
  { variable: "COOLIFY_APPLICATION_COMMERCE", name: "commerce", deploymentKind: "dockercompose", surfaces: ["commerce", "worker"] },
];

export const READ_ONLY_RELEASE_ENVIRONMENT_VARIABLES = [
  "FLEXPERIMENT_RELEASE_DATABASE",
  "FLEXPERIMENT_FRONTEND_RELEASE_URL",
  "FLEXPERIMENT_ADMIN_RELEASE_URL",
  "FLEXPERIMENT_DEPLOY_REF_REMOTE",
  "FLEXPERIMENT_DEPLOY_REF_WORKTREE",
] as const;

/**
 * The production wrapper exports these names en masse after sourcing its
 * root-owned environment file. Keep the contract public: the installation
 * contract test reads this list rather than carrying a stale second copy.
 */
export const PRODUCTION_RELEASE_ENVIRONMENT_VARIABLES = [
  "FLEXPERIMENT_RELEASE_DATABASE",
  "FLEXPERIMENT_RELEASE_REPLACEMENT_ROOT",
  "FLEXPERIMENT_RELEASE_STATE_DIR",
  "FLEXPERIMENT_RELEASE_ARCHIVE_DIR",
  "FLEXPERIMENT_RELEASE_ENVELOPE_DIR",
  "FLEXPERIMENT_RELEASE_LOCK",
  "FLEXPERIMENT_RELEASE_JOURNAL",
  "FLEXPERIMENT_RELEASE_CANDIDATE_DIR",
  "CERTIFICATION_ADMIN_BASE_URL",
  "CERTIFICATION_PUBLIC_BASE_URL",
  "CERTIFICATION_ADMIN_TOKEN",
  "CERTIFICATION_CAPABILITY_KEY",
  "CERTIFICATION_CITY_SLUG",
  "CERTIFICATION_OCCURRENCE_SCOPE",
  "CERTIFICATION_CHECKOUT_BODY",
  "COOLIFY_API_URL",
  "COOLIFY_TOKEN",
  "FLEXPERIMENT_COMMERCE_IMAGE_REPOSITORY",
  "FLEXPERIMENT_COMMERCE_WORKER_IMAGE_REPOSITORY",
  ...APPLICATIONS.map((application) => application.variable),
  "FLEXPERIMENT_FRONTEND_RELEASE_URL",
  "FLEXPERIMENT_ADMIN_RELEASE_URL",
  "FLEXPERIMENT_DEPLOY_REF_REMOTE",
  "FLEXPERIMENT_DEPLOY_REF_WORKTREE",
] as const;

const httpUrl = (value: string, variable: string, problems: string[]) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(`${variable} is not a URL`);
    return;
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    // Reading what production serves over plain HTTP from anywhere but this
    // host means a topology a network can rewrite, and topology is what the
    // safe-abort decision is made from.
    problems.push(`${variable} must be https, or loopback`);
  }
};

const demand = (env: NodeJS.ProcessEnv, variables: readonly string[]) => {
  const missing = variables.filter((variable) => !(env[variable] ?? "").trim());
  if (missing.length) throw new ReleaseConfigError("RELEASE_RUNNER_CONFIGURATION_INCOMPLETE", `missing: ${missing.join(", ")}`);
  return (variable: string) => (env[variable] as string).trim();
};

const deployRefName = (env: NodeJS.ProcessEnv, problems: string[]) => {
  const ref = (env.FLEXPERIMENT_DEPLOY_REF_NAME ?? "refs/heads/production-deploy").trim();
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref)) problems.push("FLEXPERIMENT_DEPLOY_REF_NAME is not a branch ref");
  return ref;
};

/**
 * The read-side configuration, which deliberately refuses to read the writer
 * variables even when they are present in the environment. Picking up a token
 * that happens to be exported is how a read-only command quietly becomes one
 * that could have written.
 */
export const loadReadOnlyReleaseConfig = (env: NodeJS.ProcessEnv = process.env): ReadOnlyReleaseConfig => {
  const value = demand(env, READ_ONLY_RELEASE_ENVIRONMENT_VARIABLES);
  const problems: string[] = [];
  httpUrl(value("FLEXPERIMENT_FRONTEND_RELEASE_URL"), "FLEXPERIMENT_FRONTEND_RELEASE_URL", problems);
  httpUrl(value("FLEXPERIMENT_ADMIN_RELEASE_URL"), "FLEXPERIMENT_ADMIN_RELEASE_URL", problems);
  const ref = deployRefName(env, problems);
  const predecessorConfig = predecessor(env, problems);
  if (problems.length) throw new ReleaseConfigError("RELEASE_RUNNER_CONFIGURATION_INVALID", problems.join("; "));
  return {
    databasePath: value("FLEXPERIMENT_RELEASE_DATABASE"),
    ...(predecessorConfig ? { predecessor: predecessorConfig } : {}),
    topology: {
      frontendReleaseUrl: value("FLEXPERIMENT_FRONTEND_RELEASE_URL"),
      adminReleaseUrl: value("FLEXPERIMENT_ADMIN_RELEASE_URL"),
    },
    deployRef: { remote: value("FLEXPERIMENT_DEPLOY_REF_REMOTE"), ref, worktree: value("FLEXPERIMENT_DEPLOY_REF_WORKTREE") },
  };
};

/**
 * What it takes to publish a candidate: a repository to read the commit's tree
 * out of, and a directory to write the artifact into.
 *
 * No database, no Coolify token, no write credential. Publishing a candidate
 * changes nothing about production, and a composition that could would make
 * "publishing deploys nothing" a promise instead of a fact.
 */
export const loadCandidatePublicationConfig = (env: NodeJS.ProcessEnv = process.env): CandidatePublicationConfig => {
  const value = demand(env, ["FLEXPERIMENT_RELEASE_CANDIDATE_DIR", "FLEXPERIMENT_DEPLOY_REF_REMOTE", "FLEXPERIMENT_DEPLOY_REF_WORKTREE"]);
  return {
    candidateDirectory: value("FLEXPERIMENT_RELEASE_CANDIDATE_DIR"),
    deployRef: { remote: value("FLEXPERIMENT_DEPLOY_REF_REMOTE"), worktree: value("FLEXPERIMENT_DEPLOY_REF_WORKTREE") },
  };
};

/**
 * The predecessor's identity, stated rather than discovered.
 *
 * All three or none: a bridge configured with two of them would be one that
 * reads whatever legacy database it is pointed at, and this one is bound to a
 * commit somebody reviewed.
 */
function predecessor(env: NodeJS.ProcessEnv, problems: string[]): PredecessorReleaseConfig | undefined {
  const sha = (env.FLEXPERIMENT_PREDECESSOR_SHA ?? "").trim();
  const ledger = (env.FLEXPERIMENT_PREDECESSOR_LEDGER ?? "").trim();
  const ready = (env.FLEXPERIMENT_PREDECESSOR_READY_URL ?? "").trim();
  if (!sha && !ledger && !ready) return undefined;
  if (!/^[a-f0-9]{40}$/.test(sha)) problems.push("FLEXPERIMENT_PREDECESSOR_SHA is not a commit");
  if (!/^\d{1,4}$/.test(ledger)) problems.push("FLEXPERIMENT_PREDECESSOR_LEDGER is not a migration count");
  httpUrl(ready, "FLEXPERIMENT_PREDECESSOR_READY_URL", problems);
  return { expectedSha: sha, expectedLedgerLength: Number(ledger), commerceReadyUrl: ready };
}

export const loadProductionReleaseConfig = (env: NodeJS.ProcessEnv = process.env): ProductionReleaseConfig => {
  const value = demand(env, PRODUCTION_RELEASE_ENVIRONMENT_VARIABLES);
  const problems: string[] = [];

  for (const application of APPLICATIONS) {
    if (!UUID.test(value(application.variable))) problems.push(`${application.variable} is not an application identifier`);
  }
  httpUrl(value("COOLIFY_API_URL"), "COOLIFY_API_URL", problems);
  httpUrl(value("CERTIFICATION_ADMIN_BASE_URL"), "CERTIFICATION_ADMIN_BASE_URL", problems);
  httpUrl(value("CERTIFICATION_PUBLIC_BASE_URL"), "CERTIFICATION_PUBLIC_BASE_URL", problems);
  // Parsed here so a malformed or short key is a named configuration refusal
  // rather than a failure discovered while a cutover is already fenced.
  try { parseCapabilityKeyring(value("CERTIFICATION_CAPABILITY_KEY")); }
  catch (error) { problems.push(error instanceof Error ? error.message : "CERTIFICATION_CAPABILITY_KEY is invalid"); }
  httpUrl(value("FLEXPERIMENT_FRONTEND_RELEASE_URL"), "FLEXPERIMENT_FRONTEND_RELEASE_URL", problems);
  httpUrl(value("FLEXPERIMENT_ADMIN_RELEASE_URL"), "FLEXPERIMENT_ADMIN_RELEASE_URL", problems);

  const ref = deployRefName(env, problems);
  const ciRepository = (env.FLEXPERIMENT_CI_REPOSITORY ?? "").trim();
  const ciTokenFile = (env.FLEXPERIMENT_CI_TOKEN_FILE ?? "").trim();
  if (ciRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ciRepository)) problems.push("FLEXPERIMENT_CI_REPOSITORY is not owner/name");

  const uuids = APPLICATIONS.map((application) => value(application.variable));
  if (new Set(uuids).size !== uuids.length) {
    // Two surfaces pointed at one application would deploy and roll back as
    // one, and the topology vector would stop being able to describe a partial
    // move - which is the only thing that distinguishes recovery from abort.
    problems.push("the three Coolify applications must be distinct");
  }

  if (problems.length) throw new ReleaseConfigError("RELEASE_RUNNER_CONFIGURATION_INVALID", problems.join("; "));

  return {
    databasePath: value("FLEXPERIMENT_RELEASE_DATABASE"),
    replacementRoot: value("FLEXPERIMENT_RELEASE_REPLACEMENT_ROOT"),
    stateDirectory: value("FLEXPERIMENT_RELEASE_STATE_DIR"),
    archiveDirectory: value("FLEXPERIMENT_RELEASE_ARCHIVE_DIR"),
    envelopeDirectory: value("FLEXPERIMENT_RELEASE_ENVELOPE_DIR"),
    lockPath: value("FLEXPERIMENT_RELEASE_LOCK"),
    journalPath: value("FLEXPERIMENT_RELEASE_JOURNAL"),
    candidateDirectory: value("FLEXPERIMENT_RELEASE_CANDIDATE_DIR"),
    certification: {
      adminBaseUrl: value("CERTIFICATION_ADMIN_BASE_URL"),
      publicBaseUrl: value("CERTIFICATION_PUBLIC_BASE_URL"),
      serviceToken: value("CERTIFICATION_ADMIN_TOKEN"),
      capabilityKey: value("CERTIFICATION_CAPABILITY_KEY"),
      citySlug: value("CERTIFICATION_CITY_SLUG"),
      occurrenceScopePath: value("CERTIFICATION_OCCURRENCE_SCOPE"),
      checkoutBodyPath: value("CERTIFICATION_CHECKOUT_BODY"),
    },
    predecessor: predecessor(env, problems),
    coolify: { apiUrl: value("COOLIFY_API_URL"), token: value("COOLIFY_TOKEN") },
    composeRepositories: {
      commerce: value("FLEXPERIMENT_COMMERCE_IMAGE_REPOSITORY"),
      "commerce-worker": value("FLEXPERIMENT_COMMERCE_WORKER_IMAGE_REPOSITORY"),
    },
    applications: APPLICATIONS.map((application) => ({
      name: application.name,
      uuid: value(application.variable),
      deploymentKind: application.deploymentKind,
      surfaces: application.surfaces,
    })),
    topology: {
      frontendReleaseUrl: value("FLEXPERIMENT_FRONTEND_RELEASE_URL"),
      adminReleaseUrl: value("FLEXPERIMENT_ADMIN_RELEASE_URL"),
    },
    deployRef: {
      remote: value("FLEXPERIMENT_DEPLOY_REF_REMOTE"),
      ref,
      worktree: value("FLEXPERIMENT_DEPLOY_REF_WORKTREE"),
    },
    ciAttestation: ciRepository ? { repository: ciRepository, tokenFile: ciTokenFile || undefined } : undefined,
  };
};

/**
 * The configuration as it may be written down.
 *
 * The token is never one of the fields, and the remote is reduced to its host
 * because a credentialed remote carries the credential in its userinfo. A
 * journal is read after a failure, often pasted into a ticket, and a secret
 * that reaches it has been published.
 */
export const describeConfig = (config: ProductionReleaseConfig): Record<string, unknown> => {
  let remote = "invalid";
  try {
    const parsed = new URL(config.deployRef.remote);
    remote = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // An scp-style or filesystem remote has no userinfo to leak.
    remote = config.deployRef.remote.includes("@")
      ? config.deployRef.remote.slice(config.deployRef.remote.indexOf("@") + 1)
      : config.deployRef.remote;
  }
  return {
    database: config.databasePath,
    replacementRoot: config.replacementRoot,
    stateDirectory: config.stateDirectory,
    archiveDirectory: config.archiveDirectory,
    candidateDirectory: config.candidateDirectory,
    envelopeDirectory: config.envelopeDirectory,
    coolifyApiUrl: config.coolify.apiUrl,
    certification: {
      adminBaseUrl: config.certification.adminBaseUrl,
      publicBaseUrl: config.certification.publicBaseUrl,
      citySlug: config.certification.citySlug,
    },
    applications: config.applications.map((application) => ({ name: application.name, surfaces: application.surfaces })),
    topology: config.topology,
    deployRef: { remote, ref: config.deployRef.ref, worktree: config.deployRef.worktree },
  };
};
