import type Database from "better-sqlite3";
import { parseLegalManifest, type LegalManifest } from "../legal-manifest";

export type Row = Record<string, unknown>;

export const CITY_INTEREST_SWEEP_BATCH_SIZE = 50;

export const one = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).get(...params) as T | undefined;

export const many = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).all(...params) as T[];

export class DomainError extends Error {
  constructor(readonly code: string, readonly status = 400, message = code, readonly details?: Record<string, unknown>) { super(message); }
}

export const legalManifest = (raw: unknown): LegalManifest => {
  try { return parseLegalManifest(raw); }
  catch { throw new DomainError("LEGAL_RELEASE_INVALID", 503); }
};

export function withImmediateTransaction<T>(db: Database.Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
