import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalEnvelopeSha256,
  type CutoverEnvelope, type CutoverEnvelopeStore,
} from "./cutover-envelope";

/**
 * The cutover envelope on disk, which is the only place it can live.
 *
 * The successor's `deploy_sessions` row cannot carry the intent that created
 * it: the database it would live in is the one being replaced, and it is gone
 * at exactly the moment the intent matters most. So the envelope goes on the
 * persistent volume, beside the database rather than inside it, and survives
 * the file being renamed away and a fresh baseline taking its place.
 *
 * Consumption is a separate file, not a field. Rewriting the envelope to mark
 * it consumed would mean the durable record of what was adopted and the record
 * that it was adopted are the same bytes - and a crash between the successor's
 * commit and that rewrite would leave a half-written envelope where a complete
 * one is needed to reconcile.
 */

const CONSUMED_SUFFIX = ".consumed";

export class FileCutoverEnvelopeStore implements CutoverEnvelopeStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(cutoverId: string): string {
    // A cutover id is an operator-supplied string; it must not be able to
    // address a file outside the envelope directory.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cutoverId) || cutoverId.includes("..")) {
      throw new Error("CUTOVER_ENVELOPE_ID_INVALID");
    }
    return join(this.directory, `${cutoverId}.json`);
  }

  /**
   * Temporary file, fsync, atomic rename, then fsync the directory. A reader
   * that arrives mid-write sees either the previous state or the complete new
   * one, and a power loss after the rename cannot leave the name pointing at
   * bytes that were never flushed.
   */
  write(envelope: CutoverEnvelope): void {
    const target = this.path(envelope.cutoverId);
    if (existsSync(target)) throw new Error("CUTOVER_ENVELOPE_ALREADY_EXISTS");
    const payload = `${JSON.stringify({ envelope, sha256: canonicalEnvelopeSha256(envelope) }, null, 2)}\n`;
    this.durableWrite(target, payload);
  }

  /**
   * Reads the envelope back and checks it against its own recorded digest.
   *
   * The digest is not there to stop tampering - anything that can edit the file
   * can edit the digest beside it. It catches the case the protocol actually
   * has to survive: a truncated or partially written file being read as a
   * complete instruction to adopt a cutover.
   */
  read(cutoverId: string): CutoverEnvelope | undefined {
    const target = this.path(cutoverId);
    if (!existsSync(target)) return undefined;
    let parsed: { envelope: CutoverEnvelope; sha256: string };
    try {
      parsed = JSON.parse(readFileSync(target, "utf8")) as { envelope: CutoverEnvelope; sha256: string };
    } catch {
      throw new Error("CUTOVER_ENVELOPE_UNREADABLE");
    }
    if (!parsed?.envelope || canonicalEnvelopeSha256(parsed.envelope) !== parsed.sha256) {
      throw new Error("CUTOVER_ENVELOPE_DIGEST_MISMATCH");
    }
    if (parsed.envelope.cutoverId !== cutoverId) throw new Error("CUTOVER_ENVELOPE_IDENTITY_MISMATCH");
    return parsed.envelope;
  }

  isConsumed(cutoverId: string): boolean {
    return existsSync(`${this.path(cutoverId)}${CONSUMED_SUFFIX}`);
  }

  /**
   * Only ever called after the successor database has committed the adoption.
   * The envelope itself is left in place: it is the record of what was adopted,
   * and a reconciling retry needs to read it to prove the leftover file is the
   * same handoff rather than a different one wearing the same id.
   */
  markConsumed(cutoverId: string): void {
    const target = this.path(cutoverId);
    if (!existsSync(target)) throw new Error("CUTOVER_ENVELOPE_NOT_FOUND");
    if (this.isConsumed(cutoverId)) return;
    this.durableWrite(`${target}${CONSUMED_SUFFIX}`, `${new Date().toISOString()}\n`);
  }

  private durableWrite(target: string, payload: string): void {
    const temporary = `${target}.${process.pid}.tmp`;
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeSync(file, payload);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    // The rename is only durable once the directory entry is.
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

/** Written by the predecessor, which has no database of the successor's lineage to write into. */
export const writeCutoverEnvelope = (directory: string, envelope: CutoverEnvelope): void =>
  new FileCutoverEnvelopeStore(directory).write(envelope);

export const cutoverEnvelopeDirectory = (): string =>
  process.env.COMMERCE_CUTOVER_ENVELOPE_DIR
    ?? join(dirname(process.env.COMMERCE_DATABASE_PATH ?? "/var/lib/flexperiment/commerce.sqlite"), "cutover");
