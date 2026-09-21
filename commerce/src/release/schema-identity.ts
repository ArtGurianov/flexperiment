export const LAUNCH_SCHEMA_LINEAGE = "flexperiment-launch";

export type SchemaLineage = "EMPTY_BOOTSTRAPPABLE" | "SUPPORTED" | "LEGACY" | "UNKNOWN";

export type SchemaIdentitySnapshot = {
  readonly tableNames: readonly string[];
  readonly schemaIdentity?: { readonly lineage: string } | null;
  /**
   * How many versions the ledger records, when a ledger exists. Absent means
   * "not read", which is deliberately not the same as zero: a classifier whose
   * job is to refuse must not infer emptiness it did not observe.
   */
  readonly appliedVersionCount?: number;
};

export const classifySchemaLineage = (snapshot: SchemaIdentitySnapshot): SchemaLineage => {
  const tables = new Set(snapshot.tableNames);
  if (snapshot.schemaIdentity?.lineage === LAUNCH_SCHEMA_LINEAGE) return "SUPPORTED";
  if (tables.size === 0) return "EMPTY_BOOTSTRAPPABLE";

  // An EMPTY ledger table with nothing built beside it is a bootstrap that has
  // not happened, not a pre-launch database. Reading it as LEGACY would brick a
  // fresh database permanently, and "only our own code creates that table" is
  // exactly the kind of assumption this classification exists to stop relying
  // on.
  //
  // Both halves are load-bearing. Recorded versions are evidence that a
  // migrator has already run here, whatever became of the tables it built, so
  // a populated ledger is never a bootstrap - and an unread count is not an
  // empty one.
  if (tables.size === 1 && tables.has("schema_migrations")) {
    return snapshot.appliedVersionCount === 0 ? "EMPTY_BOOTSTRAPPABLE" : "LEGACY";
  }

  // LEGACY is specifically "built by the old ledger and carrying no identity
  // at all". A database that HAS a `schema_identity` table but no usable row in
  // it is not the pre-launch product - it is something unrecognised, and the
  // two failures are not interchangeable.
  if (tables.has("schema_migrations") && !tables.has("schema_identity")) return "LEGACY";
  return "UNKNOWN";
};

export class SchemaLineageError extends Error {
  constructor(readonly code: "LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED" | "UNKNOWN_SCHEMA_LINEAGE" | "SCHEMA_NOT_BOOTSTRAPPED") {
    super(code);
  }
}

/** Runtime callers use this only after bootstrap. Empty is an explicit bootstrap state, never a running database. */
export const assertSupportedSchemaLineage = (snapshot: SchemaIdentitySnapshot): void => {
  switch (classifySchemaLineage(snapshot)) {
    case "SUPPORTED": return;
    case "LEGACY": throw new SchemaLineageError("LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED");
    case "EMPTY_BOOTSTRAPPABLE": throw new SchemaLineageError("SCHEMA_NOT_BOOTSTRAPPED");
    case "UNKNOWN": throw new SchemaLineageError("UNKNOWN_SCHEMA_LINEAGE");
  }
};
