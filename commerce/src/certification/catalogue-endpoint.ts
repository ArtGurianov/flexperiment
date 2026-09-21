import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { CertificationCapabilityError, capabilityBearerDefect, capabilityPossessionDefect, type CertificationClaim } from "./capability";
import { SqliteCertificationCatalogueAuthority, type CleanupKind } from "./catalogue-authority-sqlite";
import type { CertificationCatalogueCommand } from "./catalogue-authority";
import type { OccurrenceView } from "./evidence";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "./store-sqlite";

/**
 * The one catalogue operation a certification may ask the running system to
 * perform, and nothing else.
 *
 * It is deliberately not a remote admin executor. There is no method, path or
 * payload a caller can choose: the command is one of three named kinds, its
 * fields are typed, and the body it turns into is built here. A general
 * forwarding endpoint guarded by a token would be an admin API with one more
 * credential, which is the opposite of what a scoped certification needs.
 */

export const CERTIFICATION_SERVICE_HEADER = "Authorization";

export class CertificationEndpointError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A machine credential, compared as a digest in constant time.
 *
 * The server holds the digest, never the token: a configuration file that is
 * read by an operator, copied into a ticket or captured in a container image
 * then leaks nothing that can be presented. The comparison is constant time
 * because a token checked with `===` leaks its prefix through timing, and this
 * one opens a fence.
 */
export const authenticateCertificationService = (header: string | undefined | null, expectedSha256: string | undefined): void => {
  if (!expectedSha256?.trim()) throw new CertificationEndpointError("CERTIFICATION_SERVICE_NOT_CONFIGURED", 503);
  const raw = (header ?? "").trim();
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!token) throw new CertificationEndpointError("CERTIFICATION_SERVICE_UNAUTHENTICATED", 401);
  const presented = Buffer.from(sha256(token), "hex");
  const expected = Buffer.from(expectedSha256.trim(), "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new CertificationEndpointError("CERTIFICATION_SERVICE_UNAUTHENTICATED", 401);
  }
};

export type CatalogueCommandRequest = {
  readonly runId: string;
  readonly claim: CertificationClaim;
  readonly commandId: string;
  /** An armed business command, or a cleanup convergence. They are admitted differently. */
  readonly command: CertificationCatalogueCommand | { readonly kind: CleanupKind; readonly idempotencyKey: string };
  readonly reason: string;
};

const CLEANUP_KINDS: readonly CleanupKind[] = ["CLOSE_SALES", "HIDE_OCCURRENCE"];
const isCleanup = (command: CatalogueCommandRequest["command"]): command is { kind: CleanupKind; idempotencyKey: string } =>
  (CLEANUP_KINDS as readonly string[]).includes(command.kind);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * Parses the request into exactly one of three commands, or refuses.
 *
 * Every field is checked here rather than trusted downstream, because the
 * caller is a machine on the other side of a token and the target is the
 * production catalogue.
 */
export const parseCatalogueCommandRequest = (raw: unknown): CatalogueCommandRequest => {
  const body = (raw ?? {}) as Record<string, unknown>;
  const fail = (detail: string) => { throw new CertificationEndpointError("CERTIFICATION_CATALOGUE_REQUEST_INVALID", 422, detail); };

  const runId = String(body.run_id ?? "");
  const commandId = String(body.command_id ?? "");
  const reason = String(body.reason ?? "");
  if (!ID.test(runId)) fail("run_id");
  if (!ID.test(commandId)) fail("command_id");
  if (!reason.trim() || reason.length > 200) fail("reason");

  const claimRaw = (body.claim ?? {}) as Record<string, unknown>;
  const claim: CertificationClaim = {
    capabilityId: String(claimRaw.capability_id ?? ""),
    runId: String(claimRaw.run_id ?? ""),
    nonce: String(claimRaw.nonce ?? ""),
  };
  if (!ID.test(claim.capabilityId) || !ID.test(claim.nonce)) fail("claim");
  // The claim's run and the command's run are one run. Two fields that could
  // disagree would be two ways of saying which certification this is.
  if (claim.runId !== runId) fail("claim.run_id");

  const kind = String(body.kind ?? "");
  const command: CatalogueCommandRequest["command"] = (() => {
    if (kind === "CREATE_OCCURRENCE") {
      const draft = (body.draft ?? {}) as Record<string, unknown>;
      for (const [field, value] of [["city_id", draft.city_id], ["starts_at", draft.starts_at], ["ends_at", draft.ends_at],
        ["venue_disclosure_text", draft.venue_disclosure_text], ["venue_announce_by", draft.venue_announce_by]] as const) {
        if (typeof value !== "string" || !value.trim()) fail(`draft.${field}`);
      }
      for (const field of ["starts_at", "ends_at", "venue_announce_by"] as const) {
        if (!TIMESTAMP.test(String(draft[field]))) fail(`draft.${field}`);
      }
      return { kind, idempotencyKey: commandId, draft: {
        cityId: String(draft.city_id), startsAt: String(draft.starts_at), endsAt: String(draft.ends_at),
        venueDisclosureText: String(draft.venue_disclosure_text), venueAnnounceBy: String(draft.venue_announce_by),
      } } as CatalogueCommandRequest["command"];
    }
    if (kind === "CLOSE_SALES" || kind === "HIDE_OCCURRENCE") {
      // Cleanup names no occurrence and no revision: both come from what this
      // run actually created and from the catalogue as it is now. A caller
      // that could name them could aim a close at someone else's event.
      return { kind, idempotencyKey: commandId };
    }
    if (kind === "PUBLISH_OCCURRENCE" || kind === "OPEN_SALES") {
      const occurrenceId = String(body.occurrence_id ?? "");
      const expectedRevision = Number(body.expected_revision);
      if (!ID.test(occurrenceId)) fail("occurrence_id");
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("expected_revision");
      return { kind, idempotencyKey: commandId, occurrenceId, expectedRevision } as CatalogueCommandRequest["command"];
    }
    return fail("kind") as never;
  })();

  return { runId, claim, commandId, command, reason };
};

export type CatalogueEndpointPorts = {
  readonly db: Database.Database;
  /** Performs the mutation, synchronously, inside the authority's transaction. */
  readonly createOccurrence: (draft: { cityId: string; startsAt: string; endsAt: string; venueDisclosureText: string; venueAnnounceBy: string }, commandId: string, reason: string) => OccurrenceView;
  readonly patchOccurrence: (occurrenceId: string, patch: Record<string, unknown>, expectedRevision: number, commandId: string, reason: string) => OccurrenceView;
  /** The occurrence as it is right now, for a cleanup that must use the current revision. */
  readonly readOccurrence: (occurrenceId: string) => OccurrenceView;
  readonly now: () => Date;
  /** The commit this process is serving, which a certification must be for. */
  readonly runtimeReleaseSha: () => string;
};

/**
 * Admits one catalogue command: the service credential, the live fence, the
 * runtime's own commit, the capability, and then the mutation and its record in
 * a single transaction.
 *
 * The capability is validated but never spent here. It is spent once, by the
 * checkout, and a catalogue command that consumed it would leave the
 * certification unable to buy the thing it just published.
 */
export const performCertificationCatalogueCommand = (
  ports: CatalogueEndpointPorts,
  request: CatalogueCommandRequest,
): OccurrenceView => {
  const runs = new SqliteCertificationRunStore(ports.db);
  const run = runs.load(request.runId);
  if (!run) throw new CertificationEndpointError("CERTIFICATION_RUN_NOT_FOUND", 404, request.runId);

  const fence = ports.db.prepare("SELECT id, target_sha FROM deploy_sessions WHERE deployment_gate_closed = 1")
    .get() as { id: string; target_sha: string } | undefined;
  // A certification outside a cutover is not a certification. The fence it is
  // allowed to work behind has to exist and be this release's.
  if (!fence) throw new CertificationEndpointError("CERTIFICATION_NO_ACTIVE_DEPLOY_SESSION", 409);

  const serving = ports.runtimeReleaseSha().trim();
  if (!serving) throw new CertificationEndpointError("CERTIFICATION_RUNTIME_COMMIT_UNKNOWN", 503);
  // The runtime answering this request must be the one being certified. A
  // container still serving the old commit would otherwise publish an
  // occurrence on behalf of a release it is not running.
  if (serving !== fence.target_sha || serving !== run.releaseSha) {
    throw new CertificationEndpointError("CERTIFICATION_RUNTIME_RELEASE_MISMATCH", 409);
  }

  const capability = new SqliteCertificationCapabilityStore(ports.db).get(request.claim.capabilityId);
  const context = { deploymentSessionId: fence.id, runtimeReleaseSha: serving };
  // An armed business command needs a capability that could still be spent.
  // Cleanup needs only possession: by the time a run shuts its fixture the
  // checkout has spent the capability, and requiring an unspent one would make
  // the close unreachable and leave the occurrence for sale forever.
  const defect = isCleanup(request.command)
    ? capabilityPossessionDefect(capability, request.claim, context, run)
    : capabilityBearerDefect(capability, request.claim, context, run, ports.now());
  if (defect) throw new CertificationCapabilityError(defect);

  const authority = new SqliteCertificationCatalogueAuthority(ports.db, runs);
  // Derived, never the caller's. A fresh key must not be able to open a second
  // admin command for an operation this run has already performed.
  const commandKey = SqliteCertificationCatalogueAuthority.commandKey(request.runId, request.command.kind);
  const command = request.command;

  if (isCleanup(command)) {
    return authority.clean(request.runId, command.kind, commandKey, (occurrenceId) => {
      const current = ports.readOccurrence(occurrenceId);
      const revision = Number(current.admin_revision);
      if (!Number.isSafeInteger(revision)) throw new CertificationEndpointError("CERTIFICATION_CLEANUP_REVISION_INVALID", 409, occurrenceId);
      const patch = command.kind === "CLOSE_SALES" ? { sales_status: "CLOSED" } : { visibility: "HIDDEN" };
      return ports.patchOccurrence(occurrenceId, patch, revision, commandKey, request.reason);
    });
  }

  const armed = command as CertificationCatalogueCommand;
  return authority.admit(request.runId, armed, () => {
    if (armed.kind === "CREATE_OCCURRENCE") {
      return ports.createOccurrence(armed.draft, commandKey, request.reason);
    }
    const patch = armed.kind === "PUBLISH_OCCURRENCE" ? { visibility: "PUBLISHED" } : { sales_status: "OPEN" };
    return ports.patchOccurrence(armed.occurrenceId, patch, armed.expectedRevision, commandKey, request.reason);
  });
};
