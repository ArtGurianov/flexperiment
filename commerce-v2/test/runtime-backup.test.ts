import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupFoundation } from "../src/foundation-storage";
import { backupRuntime, openBackupSource } from "../src/backup-cli";
import { migrateV2, openV2Database } from "../src/db";
import { getEditorialDraft, getEditorialPublished, publishEditorialDraft, saveEditorialDraft } from "../src/course-editorial";

describe("normal/foundation independent read-only recovery", () => {
  it("backs up uncheckpointed WAL read-only and restores the exact schema/catalogue, without new DB facts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-runtime-backup-"));
    const filename = join(directory, "live.sqlite");
    const writer = openV2Database(filename);
    let reader: Database.Database | undefined;
    let restored: Database.Database | undefined;
    try {
      migrateV2(writer);
      writer.pragma("wal_autocheckpoint = 0");
      writer.prepare("INSERT INTO cities(id,slug,title) VALUES (?,?,?)").run("actual-row", "fixture-city", "Fixture");
      writer.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
        VALUES ('editorial-product','course:recovery','ONLINE_COURSE','FREE','recovery')`).run();
      saveEditorialDraft(writer, { expectedRevision: 0, actor: "synthetic-editor", document: {
        courseRef: "recovery", title: "Synthetic recovery course", slug: "recovery", summary: "Snapshot fixture",
        visibility: "LISTED", sections: [{ sectionRef: "recovery-section", title: "Section", position: 0, visibility: "LISTED" }],
        lessons: [{ lessonRef: "recovery-lesson", sectionRef: "recovery-section", title: "Lesson", slug: "lesson",
          position: 0, visibility: "LISTED", freePreview: true }],
      } });
      publishEditorialDraft(writer, { courseRef: "recovery", expectedRevision: 1, expectedPublishedVersion: 0,
        idempotencyKey: "synthetic-publish", actor: "synthetic-editor" });
      writer.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
        VALUES ('recovery-lesson','synthetic-video',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
      const before = writer.prepare("SELECT * FROM cities ORDER BY id").all();
      const schema = writer.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const draft = getEditorialDraft(writer, "recovery");
      const published = getEditorialPublished(writer, "recovery");
      const versions = writer.prepare("SELECT * FROM course_editorial_versions ORDER BY version").all();
      const commands = writer.prepare("SELECT * FROM course_editorial_publish_commands ORDER BY idempotency_key").all();
      const key = join(directory, "key.txt");
      execFileSync("age-keygen", ["-o", key], { stdio: "ignore" }); chmodSync(key, 0o600);
      const recipient = execFileSync("age-keygen", ["-y", key], { encoding: "utf8" }).trim();
      reader = openBackupSource(filename);
      expect(reader.readonly).toBe(true);
      reader.pragma("query_only = ON");
      expect(() => reader!.prepare("INSERT INTO cities(id,slug,title) VALUES ('no','no','no')").run()).toThrow();
      const proof = await backupFoundation(reader, { environment: "canary", sourceCommit: "a".repeat(40) }, join(directory, "archives"), recipient);
      expect(readdirSync(join(directory, "archives"))).toEqual([proof.filename]);
      expect(readFileSync(join(directory, "archives", proof.filename)).includes(Buffer.from("actual-row"))).toBe(false);
      expect(readFileSync(join(directory, "archives", proof.filename)).includes(Buffer.from("Synthetic recovery course"))).toBe(false);
      const copy = join(directory, "restored.sqlite");
      execFileSync("age", ["-d", "-i", key, "-o", copy, join(directory, "archives", proof.filename)], { stdio: "ignore" });
      restored = new Database(copy, { readonly: true, fileMustExist: true });
      expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
      expect(restored.prepare("SELECT * FROM cities ORDER BY id").all()).toEqual(before);
      expect(restored.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(schema);
      expect(getEditorialDraft(restored, "recovery")).toEqual(draft);
      expect(getEditorialPublished(restored, "recovery")).toEqual(published);
      expect(restored.prepare("SELECT * FROM course_editorial_versions ORDER BY version").all()).toEqual(versions);
      expect(restored.prepare("SELECT * FROM course_editorial_publish_commands ORDER BY idempotency_key").all()).toEqual(commands);
      expect(restored.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='recovery-lesson'").get())
        .toEqual({ active_video_id: "synthetic-video" });
      expect(writer.prepare("SELECT COUNT(*) AS n FROM deployment_durability").get()).toEqual({ n: 0 });
    } finally {
      restored?.close(); reader?.close(); writer.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create a missing source DB", () => {
    const directory = mkdtempSync(join(tmpdir(), "v2-backup-missing-"));
    try {
      expect(() => openBackupSource(join(directory, "missing.sqlite"))).toThrow();
      expect(readdirSync(directory)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([
    { COMMERCE_V2_ENVIRONMENT: "legacy" },
    { COMMERCE_V2_ENVIRONMENT: "canary", COMMERCE_V2_DATABASE_PATH: "/legacy.sqlite" },
    { COMMERCE_V2_ENVIRONMENT: "production", COMMERCE_V2_DATABASE_PATH: "/var/lib/flexperiment-v2/commerce.sqlite", COMMERCE_V2_BACKUP_PATH: "/foreign" },
  ])("refuses invalid operator context before opening a DB", async (environment) => {
    await expect(backupRuntime(environment)).rejects.toThrow(/V2_BACKUP_(ENVIRONMENT|PATH)_REQUIRED/);
  });
});
