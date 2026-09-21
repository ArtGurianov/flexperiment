import { describe, expect, it } from "vitest";
import { assertSupportedSchemaLineage, classifySchemaLineage, LAUNCH_SCHEMA_LINEAGE, SchemaLineageError } from "../../src/release/schema-identity";

/** What a pre-launch database actually looks like: a ledger with the schema it built beside it. */
const PRE_LAUNCH = ["schema_migrations", "orders", "payments", "agents", "email_outbox"];

describe("schema lineage", () => {
  it("classifies each pre-bootstrap and runtime lineage without treating legacy as bootstrapable", () => {
    expect(classifySchemaLineage({ tableNames: [] })).toBe("EMPTY_BOOTSTRAPPABLE");
    expect(classifySchemaLineage({ tableNames: ["schema_identity"], schemaIdentity: { lineage: LAUNCH_SCHEMA_LINEAGE } })).toBe("SUPPORTED");
    expect(classifySchemaLineage({ tableNames: PRE_LAUNCH })).toBe("LEGACY");
    expect(classifySchemaLineage({ tableNames: ["orders"] })).toBe("UNKNOWN");
  });

  it("reads an EMPTY bare ledger as a bootstrap that has not happened", () => {
    // Otherwise a bootstrap interrupted between creating the ledger and
    // applying the baseline would classify as LEGACY and refuse to start
    // forever.
    expect(classifySchemaLineage({ tableNames: ["schema_migrations"], appliedVersionCount: 0 })).toBe("EMPTY_BOOTSTRAPPABLE");
  });

  it("refuses a bare ledger that records versions, whatever became of its tables", () => {
    // Recorded versions are evidence a migrator already ran here. A database
    // that says so is never a fresh bootstrap, and must not be handed the
    // baseline on the strength of having no tables left.
    expect(classifySchemaLineage({ tableNames: ["schema_migrations"], appliedVersionCount: 61 })).toBe("LEGACY");
  });

  it("does not infer an emptiness it never read", () => {
    // Absent is not zero. A classifier whose job is to refuse fails closed on
    // the count it was not given.
    expect(classifySchemaLineage({ tableNames: ["schema_migrations"] })).toBe("LEGACY");
  });

  it("does not call an unrecognised identity legacy", () => {
    // Present but unusable is not the pre-launch product, and the two failures
    // are not interchangeable: one says "this is the old database", the other
    // says "nobody knows what this is".
    expect(classifySchemaLineage({ tableNames: [...PRE_LAUNCH, "schema_identity"], schemaIdentity: null })).toBe("UNKNOWN");
    expect(classifySchemaLineage({ tableNames: [...PRE_LAUNCH, "schema_identity"], schemaIdentity: { lineage: "somebody-elses-product" } })).toBe("UNKNOWN");
  });

  it("fails closed after bootstrap", () => {
    expect(() => assertSupportedSchemaLineage({ tableNames: PRE_LAUNCH })).toThrow(new SchemaLineageError("LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED"));
    expect(() => assertSupportedSchemaLineage({ tableNames: ["orders"] })).toThrow(new SchemaLineageError("UNKNOWN_SCHEMA_LINEAGE"));
    expect(() => assertSupportedSchemaLineage({ tableNames: [] })).toThrow(new SchemaLineageError("SCHEMA_NOT_BOOTSTRAPPED"));
  });
});
