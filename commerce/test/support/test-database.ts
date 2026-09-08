import { openDatabase } from "../../src/db";

/**
 * Historical migration tests require an empty SQLite database. They opt out
 * of the test-only final-schema template before applying their own migration
 * prefix, preserving replay, ordering, and failure semantics.
 */
export const openUnmigratedTestDatabase = () => openDatabase(":memory:", { testSchemaSnapshot: false });
