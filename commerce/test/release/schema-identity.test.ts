import { describe, expect, it } from "vitest";
import { assertSupportedSchemaLineage, classifySchemaLineage, LAUNCH_SCHEMA_LINEAGE, SchemaLineageError } from "../../src/release/schema-identity";

describe("schema lineage", () => {
  it("classifies each pre-bootstrap and runtime lineage without treating legacy as bootstrapable", () => {
    expect(classifySchemaLineage({ tableNames: [] })).toBe("EMPTY_BOOTSTRAPPABLE");
    expect(classifySchemaLineage({ tableNames: ["schema_identity"], schemaIdentity: { lineage: LAUNCH_SCHEMA_LINEAGE } })).toBe("SUPPORTED");
    expect(classifySchemaLineage({ tableNames: ["schema_migrations"] })).toBe("LEGACY");
    expect(classifySchemaLineage({ tableNames: ["orders"] })).toBe("UNKNOWN");
  });

  it("fails closed after bootstrap", () => {
    expect(() => assertSupportedSchemaLineage({ tableNames: ["schema_migrations"] })).toThrow(new SchemaLineageError("LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED"));
    expect(() => assertSupportedSchemaLineage({ tableNames: ["orders"] })).toThrow(new SchemaLineageError("UNKNOWN_SCHEMA_LINEAGE"));
  });
});
