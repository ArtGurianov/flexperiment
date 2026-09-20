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

  it("reads a bare ledger as a bootstrap that has not happened, not as a pre-launch database", () => {
    // Otherwise a bootstrap interrupted between creating the ledger and
    // applying the baseline would classify as LEGACY and refuse to start
    // forever. A pre-launch database is a ledger plus the schema it built.
    expect(classifySchemaLineage({ tableNames: ["schema_migrations"] })).toBe("EMPTY_BOOTSTRAPPABLE");
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
