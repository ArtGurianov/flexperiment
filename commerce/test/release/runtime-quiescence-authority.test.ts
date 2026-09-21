import { describe, expect, it } from "vitest";
import { RuntimeQuiescenceAuthority, RuntimeQuiescenceAuthorityError, type RuntimeLeaseBinding } from "../../src/release/runtime-quiescence-authority";

const binding: RuntimeLeaseBinding = {
  sessionId: "session-1", operation: "PREPARE", databasePath: "/db/commerce.sqlite", databaseIdentity: { canonicalPath: "/db/commerce.sqlite", dev: 8, ino: 42 },
  sha: "a".repeat(40), applicationUuid: "commerce-uuid", applicationResourceId: "17",
  repositories: { commerce: "repo/commerce", "commerce-worker": "repo/worker" }, lockOwner: "runner-1",
  units: [{ service: "commerce", containerId: "c1" }, { service: "commerce-worker", containerId: "c2" }],
};

const probes = (events: string[] = []) => ({
  async assertLockHeld(owner: string) { events.push(`lock:${owner}`); },
  async assertDatabaseIdentity(identity: { canonicalPath: string }) { events.push(`database:${identity.canonicalPath}`); },
  async assertUnitsStopped(value: RuntimeLeaseBinding) { events.push(`units:${value.units.map((unit) => unit.containerId).join(",")}`); },
  async assertNoSqliteHandles(path: string) { events.push(`handles:${path}`); },
});

describe("runtime quiescence authority", () => {
  it("rejects a structural copy and a second consume with the same fail-closed class", async () => {
    let now = 10;
    const authority = new RuntimeQuiescenceAuthority(() => now);
    const lease = authority.acquire(binding);
    const copy = { ...lease };
    await expect(authority.consume(copy, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
    await authority.consume(lease, binding, probes());
    await expect(authority.consume(lease, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
    now += 1;
  });

  it("expires by injected monotonic time and destroys the lease", async () => {
    let now = 0;
    const authority = new RuntimeQuiescenceAuthority(() => now, 10);
    const lease = authority.acquire(binding);
    now = 11;
    await expect(authority.consume(lease, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_EXPIRED" });
    await expect(authority.consume(lease, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
  });

  it.each(["sessionId", "operation", "databasePath", "sha"] as const)("rejects a mismatched %s", async (key) => {
    const authority = new RuntimeQuiescenceAuthority(() => 0);
    const lease = authority.acquire(binding);
    const wrong = { ...binding, [key]: key === "operation" ? "RESTORE" : `${binding[key]}-wrong` } as RuntimeLeaseBinding;
    await expect(authority.consume(lease, wrong, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_BINDING_MISMATCH" });
  });

  it("revalidates lock, exact units, and SQLite handles before completing consume", async () => {
    const authority = new RuntimeQuiescenceAuthority(() => 0);
    const lease = authority.acquire(binding);
    const events: string[] = [];
    await authority.consume(lease, binding, probes(events));
    expect(events).toEqual(["lock:runner-1", "database:/db/commerce.sqlite", "units:c1,c2", "handles:/db/commerce.sqlite", "lock:runner-1"]);
  });

  it("cannot consume a lease issued by another process-local authority", async () => {
    const first = new RuntimeQuiescenceAuthority(() => 0);
    const second = new RuntimeQuiescenceAuthority(() => 0);
    await expect(second.consume(first.acquire(binding), binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
  });

  it("invalidates a lease if any revalidation probe refuses", async () => {
    const authority = new RuntimeQuiescenceAuthority(() => 0);
    const lease = authority.acquire(binding);
    await expect(authority.consume(lease, binding, { ...probes(), async assertUnitsStopped() { throw new Error("new-container"); } }))
      .rejects.toBeInstanceOf(RuntimeQuiescenceAuthorityError);
    await expect(authority.consume(lease, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
  });

  it.each(["captured-container-restarted", "new-container-for-trusted-service"])("destroys the lease when %s", async (drift) => {
    const authority = new RuntimeQuiescenceAuthority(() => 0);
    const lease = authority.acquire(binding);
    await expect(authority.consume(lease, binding, { ...probes(), async assertUnitsStopped() { throw new Error(drift); } }))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_REVALIDATION_FAILED" });
    await expect(authority.consume(lease, binding, probes())).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
  });
});
