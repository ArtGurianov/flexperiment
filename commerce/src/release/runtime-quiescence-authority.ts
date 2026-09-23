export class RuntimeQuiescenceAuthorityError extends Error {
  constructor(readonly code: "RUNTIME_LEASE_INVALID" | "RUNTIME_LEASE_EXPIRED" | "RUNTIME_LEASE_BINDING_MISMATCH" | "RUNTIME_LEASE_REVALIDATION_FAILED", detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const authoritySecret = Symbol("runtime-quiescence-authority");

/** Opaque, frozen and deliberately fieldless: JSON/copies cannot restore it. */
class RuntimeLeaseToken {
  constructor(secret: symbol) {
    if (secret !== authoritySecret) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_INVALID");
    Object.freeze(this);
  }
}
export type RuntimeQuiescenceLease = RuntimeLeaseToken;
const issueLease = (): RuntimeQuiescenceLease => new RuntimeLeaseToken(authoritySecret);

export type RuntimeLeaseOperation = "PREPARE" | "RESTORE";
export type RuntimeLeaseDatabaseIdentity = Readonly<{ canonicalPath: string; dev: number; ino: number }>;
export type RuntimeLeaseBinding = Readonly<{
  sessionId: string;
  operation: RuntimeLeaseOperation;
  databasePath: string;
  databaseIdentity: RuntimeLeaseDatabaseIdentity;
  applicationUuid: string;
  applicationResourceId: string;
  lockOwner: string;
}>;

export type RuntimeLeaseRevalidation = {
  assertLockHeld(owner: string): Promise<void>;
  assertDatabaseIdentity(identity: RuntimeLeaseDatabaseIdentity): Promise<void>;
  assertUnitsStopped(binding: RuntimeLeaseBinding): Promise<void>;
  assertNoSqliteHandles(databasePath: string): Promise<void>;
};

type StoredLease = Readonly<{ binding: RuntimeLeaseBinding; issuedAt: number; deadline: number }>;

/**
 * Process-local authority for storage-mutation capabilities. Its WeakMap is
 * intentionally the only durable identity of a lease: no serialized object,
 * structural copy, or lease from a previous process can be consumed.
 */
export class RuntimeQuiescenceAuthority {
  readonly #leases = new WeakMap<object, StoredLease>();

  constructor(private readonly monotonicNow: () => number, private readonly ttlMs = 5_000) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_INVALID", "ttl");
  }

  acquire(binding: RuntimeLeaseBinding): RuntimeQuiescenceLease {
    this.validateBinding(binding);
    const issuedAt = this.monotonicNow();
    if (!Number.isFinite(issuedAt)) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_INVALID", "clock");
    const lease = issueLease();
    this.#leases.set(lease, Object.freeze({ binding: Object.freeze({ ...binding }), issuedAt, deadline: issuedAt + this.ttlMs }));
    return lease;
  }

  async consume(lease: object, expected: RuntimeLeaseBinding, revalidation: RuntimeLeaseRevalidation): Promise<void> {
    const stored = this.#leases.get(lease);
    // Single use is atomic with respect to async revalidation: the capability
    // is gone before any await, including every refusal below.
    this.#leases.delete(lease);
    if (!stored) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_INVALID");
    if (this.monotonicNow() > stored.deadline) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_EXPIRED");
    if (!this.sameBinding(stored.binding, expected)) throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_BINDING_MISMATCH");
    try {
      await revalidation.assertLockHeld(stored.binding.lockOwner);
      await revalidation.assertDatabaseIdentity(stored.binding.databaseIdentity);
      await revalidation.assertUnitsStopped(stored.binding);
      await revalidation.assertNoSqliteHandles(stored.binding.databasePath);
      await revalidation.assertLockHeld(stored.binding.lockOwner);
    } catch (error) {
      throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_REVALIDATION_FAILED", error instanceof Error ? error.message : undefined);
    }
  }

  private validateBinding(binding: RuntimeLeaseBinding): void {
    if (!binding.sessionId || !binding.databasePath || !binding.databaseIdentity?.canonicalPath
      || !Number.isInteger(binding.databaseIdentity.dev) || !Number.isInteger(binding.databaseIdentity.ino)
      || !binding.applicationUuid || !binding.applicationResourceId || !binding.lockOwner) {
      throw new RuntimeQuiescenceAuthorityError("RUNTIME_LEASE_INVALID", "binding");
    }
  }

  private sameBinding(left: RuntimeLeaseBinding, right: RuntimeLeaseBinding): boolean {
    return left.sessionId === right.sessionId && left.operation === right.operation && left.databasePath === right.databasePath
      && left.databaseIdentity.canonicalPath === right.databaseIdentity.canonicalPath
      && left.databaseIdentity.dev === right.databaseIdentity.dev && left.databaseIdentity.ino === right.databaseIdentity.ino
      && left.applicationUuid === right.applicationUuid && left.applicationResourceId === right.applicationResourceId
      && left.lockOwner === right.lockOwner;
  }
}
