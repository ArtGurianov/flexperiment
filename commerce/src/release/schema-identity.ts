export const LAUNCH_SCHEMA_LINEAGE = "flexperiment-launch";

export type SchemaLineage = "EMPTY_BOOTSTRAPPABLE" | "SUPPORTED" | "LEGACY" | "UNKNOWN";

export type SchemaIdentitySnapshot = {
  readonly tableNames: readonly string[];
  readonly schemaIdentity?: { readonly lineage: string } | null;
};

export const classifySchemaLineage = (snapshot: SchemaIdentitySnapshot): SchemaLineage => {
  const tables = new Set(snapshot.tableNames);
  if (tables.size === 0) return "EMPTY_BOOTSTRAPPABLE";
  if (snapshot.schemaIdentity?.lineage === LAUNCH_SCHEMA_LINEAGE) return "SUPPORTED";
  if (tables.has("schema_migrations") && !snapshot.schemaIdentity) return "LEGACY";
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
