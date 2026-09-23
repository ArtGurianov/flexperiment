import { describe, expect, it } from "vitest";
import { RuntimeQuiescenceAuthority } from "../../src/release/runtime-quiescence-authority";
import { LsofSqliteHandleProbe, RuntimeQuiescer } from "../../src/release/runtime-quiescer";

const identity = { canonicalPath: "/db/commerce.sqlite", dev: 8, ino: 9 };
const request = {
  sessionId: "session-1", operation: "PREPARE" as const, databasePath: identity.canonicalPath,
  lockOwner: "runner-1", applicationUuid: "commerce-uuid", applicationResourceId: "17",
};

const fixture = (options: {
  identities?: Array<typeof identity>;
  handlesError?: Error;
  lockError?: Error;
  reproofError?: Error;
} = {}) => {
  const events: string[] = [];
  let armed = false;
  const identities = [...(options.identities ?? [identity, identity, identity])];
  const authority = new RuntimeQuiescenceAuthority(() => 0);
  const runtime = {
    async stop() { events.push("stop"); },
    // Armed by the test after acquire: drift is what a LATER revalidation
    // discovers, and acquire takes its own clean reading first.
    async assertStopped() { events.push("reproof"); if (armed && options.reproofError) throw options.reproofError; },
    async start() { events.push("start"); },
  };
  const database = { async identity() { events.push("database"); return identities.shift() ?? identity; } };
  const handles = { async assertNoOpenHandles() { events.push("handles"); if (options.handlesError) throw options.handlesError; } };
  const lock = { async assertHeld() { events.push("lock"); if (options.lockError) throw options.lockError; } };
  const quiescer = new RuntimeQuiescer({ authority, runtime, database, handles, lock });
  return { authority, quiescer, events, armDrift: () => { armed = true; } };
};

describe("RuntimeQuiescer", () => {
  it("issues a lease only after exact capture, stop/reproof, stable DB identity, handles and lock", async () => {
    const { authority, quiescer, events } = fixture();
    const grant = await quiescer.acquire(request);
    expect(events).toEqual(["database", "lock", "stop", "reproof", "database", "handles", "lock"]);
    await authority.consume(grant.lease, grant.binding, quiescer);
    expect(events.slice(7)).toEqual(["lock", "database", "reproof", "handles", "lock"]);
  });

  it("refuses DB inode drift, handle-probe failure, and lost lock without issuing a usable lease", async () => {
    await expect(fixture({ identities: [identity, { ...identity, ino: 10 }] }).quiescer.acquire(request))
      .rejects.toMatchObject({ code: "RUNTIME_QUIESCER_DATABASE_IDENTITY_DRIFT" });
    await expect(fixture({ handlesError: new Error("lsof-exit-2") }).quiescer.acquire(request)).rejects.toThrow("lsof-exit-2");
    await expect(fixture({ lockError: new Error("lost") }).quiescer.acquire(request)).rejects.toThrow("lost");
  });

  it("destroys a consumed lease when a captured or new container appears during reproof", async () => {
    const { authority, quiescer, armDrift } = fixture({ reproofError: new Error("runtime-drift") });
    const grant = await quiescer.acquire(request);
    armDrift();
    await expect(authority.consume(grant.lease, grant.binding, quiescer)).rejects.toMatchObject({ code: "RUNTIME_LEASE_REVALIDATION_FAILED" });
    await expect(authority.consume(grant.lease, grant.binding, quiescer)).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
  });

  it("restarts only the captured pair for a safe abort before archive", async () => {
    const { quiescer, events } = fixture();
    const grant = await quiescer.acquire(request);
    await quiescer.resume(grant);
    expect(events.slice(-4)).toEqual(["lock", "reproof", "start", "lock"]);
  });
});

describe("LsofSqliteHandleProbe", () => {
  it("treats exit 1 as no handles, exit 0 as handles found, and every other code as probe failure", async () => {
    await expect(new LsofSqliteHandleProbe(async () => ({ stdout: "", exitCode: 1 })).assertNoOpenHandles("/db/commerce.sqlite"))
      .resolves.toBeUndefined();
    await expect(new LsofSqliteHandleProbe(async () => ({ stdout: "42\n", exitCode: 0 })).assertNoOpenHandles("/db/commerce.sqlite"))
      .rejects.toMatchObject({ code: "RUNTIME_QUIESCER_SQLITE_HANDLES_OPEN" });
    await expect(new LsofSqliteHandleProbe(async () => ({ stdout: "", exitCode: 2 })).assertNoOpenHandles("/db/commerce.sqlite"))
      .rejects.toMatchObject({ code: "RUNTIME_QUIESCER_HANDLE_INSPECTION_FAILED" });
  });
});
