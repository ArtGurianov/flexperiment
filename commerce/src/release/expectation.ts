import { createHash } from "node:crypto";

const INVENTORY_PREFIX = "inventory-sha256:";
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const INVENTORY_EXPECTATION = new RegExp(`^${INVENTORY_PREFIX}[a-f0-9]{64}$`);

export type InventoryExpectation = {
  readonly value: string;
  readonly digest: string;
};

/** P2 accepts only the inventory form; historical single-migration names have no new API. */
export const parseInventoryExpectation = (value: unknown): InventoryExpectation | undefined => {
  if (typeof value !== "string" || !INVENTORY_EXPECTATION.test(value)) return undefined;
  return { value, digest: value.slice(INVENTORY_PREFIX.length) };
};

export const canonicalSchemaInventory = (versions: readonly string[]): string => {
  if (versions.some((version) => !MIGRATION_NAME.test(version))) throw new Error("SCHEMA_INVENTORY_VERSION_INVALID");
  if (new Set(versions).size !== versions.length) throw new Error("SCHEMA_INVENTORY_VERSION_DUPLICATED");
  return [...versions].sort().join("\n");
};

export const schemaInventoryExpectation = (versions: readonly string[]): string =>
  `${INVENTORY_PREFIX}${createHash("sha256").update(canonicalSchemaInventory(versions)).digest("hex")}`;

export const matchesSchemaInventory = (expectation: string, versions: readonly string[]): boolean =>
  (() => {
    if (!parseInventoryExpectation(expectation)) return false;
    try { return expectation === schemaInventoryExpectation(versions); }
    catch { return false; }
  })();
