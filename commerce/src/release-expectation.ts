import { createHash } from "node:crypto";

/**
 * The single owner of migration-expectation grammar and canonicalization.
 *
 * The grammar previously lived in four places - the request DTO, two checks in
 * release-control, and candidateExpectedMigration - which is how a form can end
 * up supported by one layer and rejected by another. `inventory-sha256:` was
 * exactly that: understood by release-control, refused by the DTO, and
 * therefore unreachable over the wire.
 *
 * After this point nothing may re-derive an expectation: no trimming, no case
 * folding, no re-sorting, no rebuilding the prefix, no second regex. Callers
 * either receive a canonical value or a rejection.
 *
 * Representation is deliberately unambiguous rather than forgiving. A release
 * expectation is an identity compared by equality across shell, jq and
 * TypeScript, so accepting two spellings of the same thing would mean two
 * layers could each be self-consistent and still disagree. Non-canonical wire
 * values - uppercase hex, surrounding whitespace, a doubled prefix - are
 * refused rather than repaired.
 */

const INVENTORY_PREFIX = "inventory-sha256:";
const FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const INVENTORY = new RegExp(`^${INVENTORY_PREFIX}[a-f0-9]{64}$`);

export type CanonicalReleaseExpectation =
  | { kind: "MIGRATION_FILENAME"; value: string }
  | { kind: "MIGRATION_INVENTORY"; value: string; digest: string };

/** The one grammar. Returns undefined for anything not exactly canonical. */
export const parseReleaseExpectation = (raw: unknown): CanonicalReleaseExpectation | undefined => {
  if (typeof raw !== "string") return undefined;
  if (FILENAME.test(raw)) return { kind: "MIGRATION_FILENAME", value: raw };
  if (INVENTORY.test(raw)) return { kind: "MIGRATION_INVENTORY", value: raw, digest: raw.slice(INVENTORY_PREFIX.length) };
  return undefined;
};

export const isReleaseExpectation = (raw: unknown): raw is string => parseReleaseExpectation(raw) !== undefined;

export const isMigrationFilenameExpectation = (raw: unknown): boolean => parseReleaseExpectation(raw)?.kind === "MIGRATION_FILENAME";

export const isMigrationInventoryExpectation = (raw: unknown): boolean => parseReleaseExpectation(raw)?.kind === "MIGRATION_INVENTORY";

/**
 * The only constructor. Sorted, joined with \n, no trailing newline - a shape
 * shared byte-for-byte with the shell and jq pipelines in the deploy
 * controller, pinned by test.
 */
export const migrationInventoryExpectation = (versions: readonly string[]): string =>
  `${INVENTORY_PREFIX}${createHash("sha256").update([...versions].sort().join("\n")).digest("hex")}`;

/** Idempotent by construction: a canonical value re-canonicalizes to itself. */
export const canonicalReleaseExpectation = (raw: unknown): string | undefined => parseReleaseExpectation(raw)?.value;
