import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { createCutoverEnvelope, type CutoverEnvelope } from "../../src/release/cutover-envelope";
import { FileCutoverEnvelopeStore } from "../../src/release/cutover-envelope-file-store";
import { snapshot } from "../support/deploy-snapshot";

const TARGET = "a".repeat(40);
const OLD = "b".repeat(40);

const envelope = (over: Partial<Parameters<typeof createCutoverEnvelope>[0]> = {}): CutoverEnvelope =>
  createCutoverEnvelope({
    cutoverId: "cutover-1", targetSha: TARGET, mode: "MAINTENANCE_CUTOVER",
    preDeployTopology: snapshot(OLD),
    predecessorDatabase: { ref: "prelaunch-2026-09-20.sqlite", sha256: "f".repeat(64) },
    createdAt: "2026-09-20T11:00:00.000Z", expiresAt: "2026-09-20T13:00:00.000Z",
    adoptionNonce: "nonce-1", ...over,
  });

let volume: string;
let store: FileCutoverEnvelopeStore;
beforeEach(() => {
  volume = mkdtempSync(join(tmpdir(), "cutover-volume-"));
  store = new FileCutoverEnvelopeStore(join(volume, "cutover"));
});

describe("the cutover envelope on disk", () => {
  it("survives the database being renamed away and replaced", () => {
    // The whole reason it is a file. A successor's `deploy_sessions` row cannot
    // carry the intent that created it: the database it would live in is the
    // one being replaced, and it is gone exactly when the intent matters most.
    const database = join(volume, "commerce.sqlite");
    const predecessor = new Database(database);
    predecessor.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    predecessor.prepare("INSERT INTO schema_migrations(version) VALUES ('0001_initial.sql')").run();
    predecessor.close();

    store.write(envelope());

    // The cutover: archive the predecessor, build the successor in its place.
    renameSync(database, join(volume, "prelaunch-2026-09-20.sqlite"));
    const successor = new Database(database);
    successor.pragma("foreign_keys = ON");
    migrate(successor);
    expect(successor.prepare("SELECT lineage FROM schema_identity WHERE singleton = 1").get())
      .toEqual({ lineage: "flexperiment-launch" });
    successor.close();

    const recovered = new FileCutoverEnvelopeStore(join(volume, "cutover")).read("cutover-1");
    expect(recovered).toMatchObject({ cutoverId: "cutover-1", targetSha: TARGET });
    expect(recovered!.predecessorDatabase.ref).toBe("prelaunch-2026-09-20.sqlite");
  });

  it("is readable by a process that did not write it", () => {
    // A restart between writing and adopting is the ordinary case, not an edge:
    // the predecessor writes it and the successor's runtime reads it.
    store.write(envelope());
    expect(new FileCutoverEnvelopeStore(join(volume, "cutover")).read("cutover-1")).toMatchObject({ cutoverId: "cutover-1" });
  });

  it("keeps the envelope and its directory to itself", () => {
    store.write(envelope());
    expect(statSync(join(volume, "cutover")).mode & 0o777).toBe(0o700);
    expect(statSync(join(volume, "cutover", "cutover-1.json")).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", () => {
    // A reader that sees a half-written file must not be able to find one.
    store.write(envelope());
    expect(readdirSync(join(volume, "cutover"))).toEqual(["cutover-1.json"]);
  });

  it("refuses a truncated or edited envelope rather than adopting it", () => {
    store.write(envelope());
    const path = join(volume, "cutover", "cutover-1.json");
    const written = readFileSync(path, "utf8");

    writeFileSync(path, written.slice(0, Math.floor(written.length / 2)));
    expect(() => store.read("cutover-1")).toThrow("CUTOVER_ENVELOPE_UNREADABLE");

    const parsed = JSON.parse(written) as { envelope: CutoverEnvelope; sha256: string };
    writeFileSync(path, JSON.stringify({ ...parsed, envelope: { ...parsed.envelope, targetSha: "c".repeat(40) } }));
    expect(() => store.read("cutover-1")).toThrow("CUTOVER_ENVELOPE_DIGEST_MISMATCH");
  });

  it("refuses an envelope filed under someone else's id", () => {
    store.write(envelope());
    renameSync(join(volume, "cutover", "cutover-1.json"), join(volume, "cutover", "cutover-2.json"));
    expect(() => store.read("cutover-2")).toThrow("CUTOVER_ENVELOPE_IDENTITY_MISMATCH");
  });

  it("will not write a second envelope over the first", () => {
    store.write(envelope());
    expect(() => store.write(envelope({ adoptionNonce: "nonce-2" }))).toThrow("CUTOVER_ENVELOPE_ALREADY_EXISTS");
    expect(store.read("cutover-1")!.adoptionNonce).toBe("nonce-1");
  });

  it("records consumption beside the envelope, not inside it", () => {
    // A crash between the successor's commit and this mark must leave a
    // complete envelope to reconcile from, so consumption never rewrites it.
    store.write(envelope());
    const before = readFileSync(join(volume, "cutover", "cutover-1.json"), "utf8");
    expect(store.isConsumed("cutover-1")).toBe(false);

    store.markConsumed("cutover-1");
    expect(store.isConsumed("cutover-1")).toBe(true);
    expect(readFileSync(join(volume, "cutover", "cutover-1.json"), "utf8")).toBe(before);
    expect(store.read("cutover-1")).toMatchObject({ cutoverId: "cutover-1" });

    // Marking it again is the reconciling retry, not an error.
    expect(() => store.markConsumed("cutover-1")).not.toThrow();
  });

  it("refuses to mark an envelope that was never written", () => {
    expect(() => store.markConsumed("cutover-1")).toThrow("CUTOVER_ENVELOPE_NOT_FOUND");
  });

  it("will not let a cutover id address a file outside its own directory", () => {
    for (const id of ["../escape", "a/b", "..", ""]) {
      expect(() => store.read(id), id).toThrow("CUTOVER_ENVELOPE_ID_INVALID");
    }
  });

  it("reports an absent envelope as absent, not as an error", () => {
    expect(store.read("cutover-1")).toBeUndefined();
    expect(store.isConsumed("cutover-1")).toBe(false);
  });
});
