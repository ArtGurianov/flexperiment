import { describe, expect, it } from "vitest";
import { canonicalSchemaInventory, matchesSchemaInventory, parseInventoryExpectation, schemaInventoryExpectation } from "../../src/release/expectation";

describe("release inventory expectations", () => {
  const versions = ["0002_follow_up.sql", "0001_launch_baseline.sql"];

  it("has one canonical inventory identity irrespective of caller order", () => {
    const expectation = schemaInventoryExpectation(versions);
    expect(parseInventoryExpectation(expectation)).toEqual({ value: expectation, digest: expectation.slice("inventory-sha256:".length) });
    expect(matchesSchemaInventory(expectation, [...versions].reverse())).toBe(true);
    expect(canonicalSchemaInventory(versions)).toBe("0001_launch_baseline.sql\n0002_follow_up.sql");
  });

  it("does not retain historical single-migration spelling or normalize malformed input", () => {
    expect(parseInventoryExpectation("0001_launch_baseline.sql")).toBeUndefined();
    expect(parseInventoryExpectation(` ${schemaInventoryExpectation(versions)}`)).toBeUndefined();
    expect(() => canonicalSchemaInventory(["0001_launch_baseline.sql", "0001_launch_baseline.sql"])).toThrow("SCHEMA_INVENTORY_VERSION_DUPLICATED");
  });
});
