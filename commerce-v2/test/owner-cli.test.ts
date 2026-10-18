import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { openOwnerDatabase, ownerCommandReadsInput, runOwnerCommand } from "../src/owner-cli";
import { stageALegalManifest } from "./fixtures/legal";

let db: Database.Database;
const now = "2026-10-18T12:00:00.000Z";
const enabled = { MARKETING_BROADCASTS_ENABLED: "true" };
const payload = {
  subject: "Новый урок", message: "Урок уже доступен",
  course: { title: "Course", slug: "course", contentVersion: "2026-10-18T10:00:00Z" },
  lessons: [{ lessonRef: "lesson-one", title: "lesson-one", slug: "lesson-one" }],
};
const run = (argv: string[], input?: unknown, environment: Record<string, string> = {}) =>
  runOwnerCommand(db, argv, input, environment, now);
const audit = () => db.prepare("SELECT admin_id,action,entity_type FROM control_room_audit_log ORDER BY created_at,action").all();
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','FREE','course-one')`).run();
});

describe("owner commands over SSH (ART-31)", () => {
  it("activates a legal release with the owner as actor, audited in the same transaction", () => {
    const result = run(["legal-release", "activate", "--actor", "art"], { storefront: "COURSES", version: "stage-a-v2", manifest: stageALegalManifest });
    expect(result).toMatchObject({ storefront: "COURSES", version: "stage-a-v2", stage: "A" });
    expect(db.prepare("SELECT version,active FROM legal_releases").all()).toEqual([{ version: "stage-a-v2", active: 1 }]);
    expect(db.prepare("SELECT actor FROM audit_log WHERE action='LEGAL_RELEASE_ACTIVATED'").get()).toEqual({ actor: "owner-cli:art" });
    expect(audit()).toEqual([{ admin_id: "owner-cli:art", action: "LEGAL_RELEASE_ACTIVATED", entity_type: "legal_release" }]);
  });

  it("writes nothing when the audit row cannot be written", () => {
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON control_room_audit_log BEGIN SELECT RAISE(ABORT,'AUDIT_UNAVAILABLE'); END");
    expect(() => run(["legal-release", "activate", "--actor", "art"], { storefront: "COURSES", version: "v2", manifest: stageALegalManifest }))
      .toThrow("AUDIT_UNAVAILABLE");
    expect(count("legal_releases")).toBe(0);
    expect(count("audit_log")).toBe(0);
  });

  it("requires a named actor for every write", () => {
    for (const argv of [["legal-release", "activate"], ["campaign", "create", "--actor", "Art Gurianov"], ["campaign", "create", "--actor"]]) {
      expect(() => run(argv, { storefront: "COURSES", version: "v", manifest: stageALegalManifest }), argv.join(" ")).toThrow("OWNER_COMMAND_ACTOR_REQUIRED");
    }
    expect(count("legal_releases") + count("control_room_audit_log")).toBe(0);
  });

  it("creates, confirms and retries campaigns only while broadcasts are legally enabled, and never sends", () => {
    const created = run(["campaign", "create", "--actor", "art"], { courseRef: "course-one", idempotencyKey: "owner:lesson-one", payload }) as { id: string };
    expect(run(["campaign", "status", created.id])).toMatchObject({ id: created.id, state: "DRAFT" });
    expect(() => run(["campaign", "confirm", created.id, "--actor", "art"])).toThrow("MARKETING_BROADCASTS_DISABLED");
    expect(() => run(["campaign", "retry", created.id, "--actor", "art"])).toThrow("MARKETING_BROADCASTS_DISABLED");
    expect(db.prepare("SELECT state FROM notification_campaigns").get()).toEqual({ state: "DRAFT" });

    run(["campaign", "confirm", created.id, "--actor", "art"], undefined, enabled);
    expect(db.prepare("SELECT state,confirmed_by FROM notification_campaigns").get()).toEqual({ state: "CONFIRMED", confirmed_by: "owner-cli:art" });
    // Queued for the server's dispatch sweep; this process delivered nothing.
    expect(db.prepare("SELECT COUNT(*) AS n FROM notification_campaign_recipients WHERE state<>'PENDING'").get()).toEqual({ n: 0 });
    expect(() => run(["campaign", "retry", created.id, "--actor", "art"], undefined, enabled)).toThrow("CAMPAIGN_NOT_RETRYABLE");
    expect(audit()).toEqual([
      { admin_id: "owner-cli:art", action: "CAMPAIGN_CONFIRMED", entity_type: "notification_campaign" },
      { admin_id: "owner-cli:art", action: "CAMPAIGN_CREATED", entity_type: "notification_campaign" },
    ]);
  });

  it("refuses unknown commands, malformed ids and input without writing", () => {
    expect(() => run(["campaign", "dispatch", "00000000-0000-0000-0000-000000000000", "--actor", "art"], undefined, enabled)).toThrow("OWNER_COMMAND_UNKNOWN");
    expect(() => run(["sales", "activate", "--actor", "art"], {})).toThrow("OWNER_COMMAND_UNKNOWN");
    expect(() => run(["campaign", "confirm", "x'; DROP TABLE x;--", "--actor", "art"], undefined, enabled)).toThrow("OWNER_COMMAND_ID_INVALID");
    expect(() => run(["legal-release", "activate", "--actor", "art"], [])).toThrow("OWNER_COMMAND_INPUT_INVALID");
    expect(() => run(["legal-release", "activate", "--actor", "art"], { storefront: "PARTNERS", version: "v", manifest: stageALegalManifest }))
      .toThrow("LEGAL_RELEASE_INPUT_INVALID");
    expect(count("legal_releases") + count("notification_campaigns") + count("control_room_audit_log")).toBe(0);
  });
});

describe("owner command input", () => {
  it("reads stdin only for commands that take a document", () => {
    expect(ownerCommandReadsInput(["legal-release", "activate", "--actor", "art"])).toBe(true);
    expect(ownerCommandReadsInput(["campaign", "create", "--actor", "art"])).toBe(true);
    for (const verb of ["status", "confirm", "retry"]) expect(ownerCommandReadsInput(["campaign", verb, "id", "--actor", "art"])).toBe(false);
  });
});

describe("owner database", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "owner-cli-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("opens only an existing database and never creates or migrates one", () => {
    expect(() => openOwnerDatabase({})).toThrow("OWNER_COMMAND_DATABASE_REQUIRED");
    expect(() => openOwnerDatabase({ COMMERCE_V2_DATABASE_PATH: ":memory:" })).toThrow("OWNER_COMMAND_DATABASE_REQUIRED");
    expect(() => openOwnerDatabase({ COMMERCE_V2_DATABASE_PATH: join(directory, "missing.sqlite") })).toThrow("OWNER_COMMAND_DATABASE_REQUIRED");
  });
});
