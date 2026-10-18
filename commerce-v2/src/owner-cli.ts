import Database from "better-sqlite3";
import { campaignStatus, confirmCampaign, createCampaign, retryCampaign } from "./campaigns";
import { auditControlRoom } from "./control-room-auth";
import { acceptControlRoomTotp, CONTROL_ROOM_ADMIN_ID, controlRoomTotpKey, enrollControlRoomTotp, resetControlRoomTotp } from "./control-room-totp";
import { activateLegalRelease, type LegalReleaseManifest } from "./legal-control";

/**
 * Owner commands that used to sit behind PLATFORM_SERVICE_TOKEN (ART-31). They run over SSH inside
 * the Commerce container, so no network credential reaches them and no web session can replace TOTP:
 *
 *   docker exec -i <commerce> node --import tsx commerce-v2/src/owner-cli.ts <command> --actor <name> [id] < input.json
 *
 * Campaign delivery stays with the server's own dispatch sweep, behind the erasure fence; this
 * process never sends email. The TOTP commands are the only recovery for the second factor.
 * Every write is audited in the Control Room audit log.
 */
export type OwnerCommandEnvironment = Readonly<Record<string, string | undefined>>;

const ACTOR = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CAMPAIGN_ID = /^[0-9a-f-]{36}$/;

const object = (input: unknown) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("OWNER_COMMAND_INPUT_INVALID");
  return input as Record<string, unknown>;
};

function parse(argv: readonly string[]) {
  const positional: string[] = [];
  let actor: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--actor") { actor = argv[i + 1]; i += 1; } else positional.push(argv[i]);
  }
  const [group, verb, id, ...rest] = positional;
  if (!group || !verb || rest.length) throw new Error("OWNER_COMMAND_UNKNOWN");
  return { command: `${group} ${verb}`, id, actor };
}

const INPUT_COMMANDS = new Set(["legal-release activate", "campaign create", "totp confirm"]);

/** Only commands that take a JSON document read stdin, so the others never wait on a terminal. */
export const ownerCommandReadsInput = (argv: readonly string[]) => INPUT_COMMANDS.has(parse(argv).command);

export function runOwnerCommand(
  db: Database.Database, argv: readonly string[], input: unknown,
  environment: OwnerCommandEnvironment, now = new Date().toISOString(),
) {
  const { command, id, actor } = parse(argv);
  if (command === "campaign status") {
    if (!id || !CAMPAIGN_ID.test(id)) throw new Error("OWNER_COMMAND_ID_INVALID");
    return campaignStatus(db, id);
  }
  if (!actor || !ACTOR.test(actor)) throw new Error("OWNER_COMMAND_ACTOR_REQUIRED");
  const adminId = `owner-cli:${actor}`;
  // The command and its audit row commit together or not at all.
  const audited = <T>(action: string, entityType: string, run: () => T, entityId: (result: T) => string,
    details: (result: T) => Record<string, unknown> = () => ({})) => db.transaction(() => {
    const result = run();
    auditControlRoom(db, { adminId, action, entityType, entityId: entityId(result), details: details(result) }, now);
    return result;
  }).immediate();

  switch (command) {
    case "legal-release activate": {
      if (id !== undefined) throw new Error("OWNER_COMMAND_UNKNOWN");
      const body = object(input);
      const storefront = body.storefront;
      if ((storefront !== "COURSES" && storefront !== "LAB") || typeof body.version !== "string") throw new Error("LEGAL_RELEASE_INPUT_INVALID");
      const release = { storefront: storefront as "COURSES" | "LAB", version: body.version, manifest: object(body.manifest) as LegalReleaseManifest, actor: adminId };
      return audited("LEGAL_RELEASE_ACTIVATED", "legal_release", () => activateLegalRelease(db, release, now),
        (result) => result.id, (result) => ({ storefront: result.storefront, version: result.version, manifestHash: result.manifestHash }));
    }
    case "campaign create": {
      if (id !== undefined) throw new Error("OWNER_COMMAND_UNKNOWN");
      const body = object(input);
      if (typeof body.courseRef !== "string" || typeof body.idempotencyKey !== "string") throw new Error("OWNER_COMMAND_INPUT_INVALID");
      const campaign = { courseRef: body.courseRef, idempotencyKey: body.idempotencyKey, payload: object(body.payload) };
      return audited("CAMPAIGN_CREATED", "notification_campaign", () => createCampaign(db, campaign),
        (result) => result.id, (result) => ({ kind: result.kind, replayed: result.replayed }));
    }
    case "campaign confirm":
    case "campaign retry": {
      if (environment.MARKETING_BROADCASTS_ENABLED !== "true") throw new Error("MARKETING_BROADCASTS_DISABLED");
      if (!id || !CAMPAIGN_ID.test(id)) throw new Error("OWNER_COMMAND_ID_INVALID");
      return command === "campaign confirm"
        ? audited("CAMPAIGN_CONFIRMED", "notification_campaign", () => confirmCampaign(db, id, adminId, now), () => id)
        : audited("CAMPAIGN_RETRIED", "notification_campaign", () => retryCampaign(db, id, now), () => id,
          (result) => ({ retriedRecipients: result.retriedRecipients }));
    }
    // Recovery without recovery codes (ART-31): only the owner over SSH can (re)bind the factor.
    case "totp enroll":
    case "totp confirm": {
      if (id !== undefined) throw new Error("OWNER_COMMAND_UNKNOWN");
      const key = controlRoomTotpKey(environment.CONTROL_ROOM_TOTP_KEY);
      if (!key) throw new Error("CONTROL_ROOM_TOTP_NOT_CONFIGURED");
      const at = new Date(now);
      if (command === "totp enroll") {
        // The secret goes to the owner's terminal once; the audit row never carries it.
        return audited("TOTP_ENROLLMENT_STARTED", "admin_totp", () => enrollControlRoomTotp(db, key, at), () => CONTROL_ROOM_ADMIN_ID);
      }
      const code = object(input).code;
      // Sessions opened before the factor existed do not outlive its confirmation.
      return audited("TOTP_ENROLLED", "admin_totp", () => {
        if (!acceptControlRoomTotp(db, key, code, at, { confirming: true })) throw new Error("CONTROL_ROOM_TOTP_CODE_INVALID");
        return { confirmed: true, sessionsRevoked: revokeSessions(db, now) };
      }, () => CONTROL_ROOM_ADMIN_ID, (result) => ({ sessionsRevoked: result.sessionsRevoked }));
    }
    case "totp reset":
      if (id !== undefined) throw new Error("OWNER_COMMAND_UNKNOWN");
      return audited("TOTP_RESET", "admin_totp", () => resetControlRoomTotp(db, new Date(now)), () => CONTROL_ROOM_ADMIN_ID,
        (result) => ({ sessionsRevoked: result.sessionsRevoked }));
    case "session revoke-all":
      if (id !== undefined) throw new Error("OWNER_COMMAND_UNKNOWN");
      return audited("SESSIONS_REVOKED", "admin_session", () => ({ sessionsRevoked: revokeSessions(db, now) }),
        () => CONTROL_ROOM_ADMIN_ID, (result) => result);
    default:
      throw new Error("OWNER_COMMAND_UNKNOWN");
  }
}

const revokeSessions = (db: Database.Database, now: string) => db.prepare(
  "UPDATE control_room_admin_sessions SET revoked_at=? WHERE revoked_at IS NULL").run(now).changes;

/** The running server owns migrations: this opens only an existing, already migrated database. */
export function openOwnerDatabase(environment: OwnerCommandEnvironment) {
  const path = environment.COMMERCE_V2_DATABASE_PATH;
  if (!path || path === ":memory:") throw new Error("OWNER_COMMAND_DATABASE_REQUIRED");
  let db: Database.Database;
  try { db = new Database(path, { fileMustExist: true }); } catch { throw new Error("OWNER_COMMAND_DATABASE_REQUIRED"); }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

async function readInput() {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 64 * 1024) throw new Error("OWNER_COMMAND_INPUT_INVALID");
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { throw new Error("OWNER_COMMAND_INPUT_INVALID"); }
}

// Importing the module for tests does not run the operator command.
if (process.argv[1]?.endsWith("/owner-cli.ts")) {
  process.umask(0o077);
  void (async () => {
    const db = openOwnerDatabase(process.env);
    const argv = process.argv.slice(2);
    const input = ownerCommandReadsInput(argv) ? await readInput() : undefined;
    try { console.log(JSON.stringify(runOwnerCommand(db, argv, input, process.env))); }
    finally { db.close(); }
  })().catch((error) => {
    const code = error instanceof Error ? error.message : "";
    console.error(/^[A-Z][A-Z0-9_]{2,100}(:[a-z_]{1,40})?$/.test(code) ? code : "OWNER_COMMAND_REFUSED");
    process.exitCode = 1;
  });
}
