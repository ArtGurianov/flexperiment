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

export class ReleaseConfigError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type SurfaceApplicationConfig = {
  readonly name: string;
  readonly uuid: string;
  readonly surfaces: readonly ("frontend" | "admin" | "commerce" | "worker")[];
};

export type ProductionReleaseConfig = {
  /** The live SQLite file the runner reads the release authority out of. */
  readonly databasePath: string;
  /** Where a predecessor database is archived to, and restored from. */
  readonly archiveDirectory: string;
  /** Survives the database being replaced and the containers being swapped. */
  readonly envelopeDirectory: string;
  /** One cutover at a time, enforced by the filesystem rather than by convention. */
  readonly lockPath: string;
  /** Append-only, secret-free record of what this run did. */
  readonly journalPath: string;
  readonly coolify: { readonly apiUrl: string; readonly token: string };
  readonly applications: readonly SurfaceApplicationConfig[];
  readonly topology: { readonly frontendReleaseUrl: string; readonly adminReleaseUrl: string };
  readonly deployRef: { readonly remote: string; readonly ref: string; readonly worktree: string };
};

const UUID = /^[0-9a-zA-Z][0-9a-zA-Z._-]{7,63}$/;

/**
 * The three Coolify applications, and which of the four surfaces each one
 * serves. `commerce` carries its own worker in the same application, which is
 * why a surface list is not a single name: a topology of four is deployed by
 * three moving parts, and pretending otherwise would leave the worker
 * unaccounted for at exactly the moment convergence is judged.
 */
const APPLICATIONS: readonly (readonly [string, string, SurfaceApplicationConfig["surfaces"]])[] = [
  ["COOLIFY_APPLICATION_FRONTEND", "frontend", ["frontend"]],
  ["COOLIFY_APPLICATION_ADMIN", "admin", ["admin"]],
  ["COOLIFY_APPLICATION_COMMERCE", "commerce", ["commerce", "worker"]],
];

const REQUIRED = [
  "FLEXPERIMENT_RELEASE_DATABASE",
  "FLEXPERIMENT_RELEASE_ARCHIVE_DIR",
  "FLEXPERIMENT_RELEASE_ENVELOPE_DIR",
  "FLEXPERIMENT_RELEASE_LOCK",
  "FLEXPERIMENT_RELEASE_JOURNAL",
  "COOLIFY_API_URL",
  "COOLIFY_TOKEN",
  ...APPLICATIONS.map(([variable]) => variable),
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

export const loadProductionReleaseConfig = (env: NodeJS.ProcessEnv = process.env): ProductionReleaseConfig => {
  const missing = REQUIRED.filter((variable) => !(env[variable] ?? "").trim());
  if (missing.length) throw new ReleaseConfigError("RELEASE_RUNNER_CONFIGURATION_INCOMPLETE", `missing: ${missing.join(", ")}`);

  const value = (variable: string) => (env[variable] as string).trim();
  const problems: string[] = [];

  for (const [variable] of APPLICATIONS) {
    if (!UUID.test(value(variable))) problems.push(`${variable} is not an application identifier`);
  }
  httpUrl(value("COOLIFY_API_URL"), "COOLIFY_API_URL", problems);
  httpUrl(value("FLEXPERIMENT_FRONTEND_RELEASE_URL"), "FLEXPERIMENT_FRONTEND_RELEASE_URL", problems);
  httpUrl(value("FLEXPERIMENT_ADMIN_RELEASE_URL"), "FLEXPERIMENT_ADMIN_RELEASE_URL", problems);

  const ref = (env.FLEXPERIMENT_DEPLOY_REF_NAME ?? "refs/heads/production-deploy").trim();
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref)) problems.push("FLEXPERIMENT_DEPLOY_REF_NAME is not a branch ref");

  const uuids = APPLICATIONS.map(([variable]) => value(variable));
  if (new Set(uuids).size !== uuids.length) {
    // Two surfaces pointed at one application would deploy and roll back as
    // one, and the topology vector would stop being able to describe a partial
    // move - which is the only thing that distinguishes recovery from abort.
    problems.push("the three Coolify applications must be distinct");
  }

  if (problems.length) throw new ReleaseConfigError("RELEASE_RUNNER_CONFIGURATION_INVALID", problems.join("; "));

  return {
    databasePath: value("FLEXPERIMENT_RELEASE_DATABASE"),
    archiveDirectory: value("FLEXPERIMENT_RELEASE_ARCHIVE_DIR"),
    envelopeDirectory: value("FLEXPERIMENT_RELEASE_ENVELOPE_DIR"),
    lockPath: value("FLEXPERIMENT_RELEASE_LOCK"),
    journalPath: value("FLEXPERIMENT_RELEASE_JOURNAL"),
    coolify: { apiUrl: value("COOLIFY_API_URL"), token: value("COOLIFY_TOKEN") },
    applications: APPLICATIONS.map(([variable, name, surfaces]) => ({ name, uuid: value(variable), surfaces })),
    topology: {
      frontendReleaseUrl: value("FLEXPERIMENT_FRONTEND_RELEASE_URL"),
      adminReleaseUrl: value("FLEXPERIMENT_ADMIN_RELEASE_URL"),
    },
    deployRef: {
      remote: value("FLEXPERIMENT_DEPLOY_REF_REMOTE"),
      ref,
      worktree: value("FLEXPERIMENT_DEPLOY_REF_WORKTREE"),
    },
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
    archiveDirectory: config.archiveDirectory,
    envelopeDirectory: config.envelopeDirectory,
    coolifyApiUrl: config.coolify.apiUrl,
    applications: config.applications.map((application) => ({ name: application.name, surfaces: application.surfaces })),
    topology: config.topology,
    deployRef: { remote, ref: config.deployRef.ref, worktree: config.deployRef.worktree },
  };
};
