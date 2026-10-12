import { chmodSync, linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErasureInstallationEvidence, assertFoundationErasureAdmission } from "../src/erasure-installation";
import { prepareErasureRuntime } from "../src/erasure-runtime";
import { migrateV2, openV2Database } from "../src/db";
import { installationFixture } from "./fixtures/erasure-installation";
import type Database from "better-sqlite3";

const environment = { DEPLOY_ENV: "staging" };
const call = (installation: ErasureInstallationEvidence, enabled?: string) => prepareErasureRuntime({
  db: {} as Database.Database, environment: { ...environment, ERASURE_FENCING_ENABLED: enabled },
  forbiddenRoots: ["/merchant"], installation,
});

describe("independent non-env installation admission", () => {
  it.each([undefined, "false"])("preserves NEVER_INSTALLED behavior with fencing=%s", async enabled => {
    expect(await call(installationFixture("NEVER_INSTALLED").read(), enabled)).toBeUndefined();
  });
  it("requires owner installation admission before first enabling", async () => {
    await expect(call(installationFixture("NEVER_INSTALLED").read(), "true")).rejects.toThrow("INSTALLATION_NOT_ADMITTED");
  });
  it.each([undefined, "false"])("refuses installed → %s independently of merchant facts", async enabled => {
    const fixture = installationFixture("REQUIRED"); const read = vi.fn(async () => { throw new Error("SHOULD_NOT_FETCH"); });
    await expect(prepareErasureRuntime({ db: {} as Database.Database, environment: { ...environment, ERASURE_FENCING_ENABLED: enabled },
      forbiddenRoots: ["/merchant"], installation: fixture.read(), libraryRead: read })).rejects.toThrow("DOWNGRADE_REFUSED");
    expect(read).not.toHaveBeenCalled();
  });
  it("an older merchant SQLite cannot erase installation evidence", async () => {
    const db = openV2Database(":memory:"); migrateV2(db);
    const bytes = db.serialize(); db.close();
    const DatabaseConstructor = (await import("better-sqlite3")).default;
    const restored = new DatabaseConstructor(bytes);
    try {
      await expect(prepareErasureRuntime({ db: restored, environment, forbiddenRoots: ["/merchant"],
        installation: installationFixture("REQUIRED").read() })).rejects.toThrow("DOWNGRADE_REFUSED");
      expect(restored.serialize()).toEqual(bytes);
    } finally { restored.close(); }
  });
  it("pins scope and protected fence path rather than trusting replacement env", async () => {
    const installation = installationFixture("REQUIRED").read();
    await expect(prepareErasureRuntime({ db: {} as Database.Database, environment: { DEPLOY_ENV: "production" },
      forbiddenRoots: ["/merchant"], installation })).rejects.toThrow("SCOPE_MISMATCH");
    await expect(prepareErasureRuntime({ db: {} as Database.Database, environment: { ...environment, ERASURE_FENCING_ENABLED: "true", ERASURE_SCOPE: "canary", ERASURE_FENCE_DIRECTORY: "/other/empty-fence" },
      forbiddenRoots: ["/merchant"], installation })).rejects.toThrow("BINDING_MISMATCH");
  });
  it("cannot manufacture installation from JSON, restored rows or own assert methods", async () => {
    const fake = { policy: installationFixture("NEVER_INSTALLED").policy, assert: () => undefined } as unknown as ErasureInstallationEvidence;
    await expect(call(fake)).rejects.toThrow("INSTALLATION_UNVERIFIED");
  });
  it("cannot use foundation as an installed runtime fallback", () => {
    expect(() => assertFoundationErasureAdmission(environment, installationFixture("NEVER_INSTALLED").read())).not.toThrow();
    for (const enabled of [undefined, "false", "true"]) {
      expect(() => assertFoundationErasureAdmission({ ...environment, ERASURE_FENCING_ENABLED: enabled }, installationFixture("REQUIRED").read())).toThrow("FOUNDATION_START_FORBIDDEN");
    }
  });
  it.each(["missing", "corrupt", "writable", "symlink", "hardlink", "directory writable", "not mounted", "rw mount", "ambiguous mount", "wrong owner", "oversized"])
    ("fails closed on %s evidence, never infers NEVER_INSTALLED", kind => {
      const fixture = installationFixture("REQUIRED"); const file = join(fixture.options.directory, "installation.json");
      const options = { ...fixture.options };
      if (kind === "missing") { chmodSync(options.directory, 0o700); rmSync(file); chmodSync(options.directory, 0o555); }
      if (kind === "corrupt" || kind === "oversized") { chmodSync(file, 0o600); writeFileSync(file, kind === "corrupt" ? "SECRET invalid JSON" : "a".repeat(4097)); chmodSync(file, 0o444); }
      if (kind === "writable") chmodSync(file, 0o644);
      if (kind === "directory writable") chmodSync(options.directory, 0o755);
      if (kind === "symlink" || kind === "hardlink") {
        chmodSync(options.directory, 0o700);
        const copy = join(options.directory, "copy.json"); writeFileSync(copy, readFileSync(file), { mode: 0o444 }); rmSync(file);
        if (kind === "symlink") symlinkSync(copy, file); else linkSync(copy, file);
        chmodSync(options.directory, 0o555);
      }
      if (kind === "not mounted") options.mountInfo = "";
      if (kind === "rw mount") options.mountInfo = options.mountInfo.replace(" ro ", " rw ");
      if (kind === "ambiguous mount") options.mountInfo += options.mountInfo.replace(" ro ", " rw ");
      if (kind === "wrong owner") options.ownerUid += 1;
      expect(() => ErasureInstallationEvidence.read(environment, options)).toThrow("EVIDENCE_INVALID");
    });
});
