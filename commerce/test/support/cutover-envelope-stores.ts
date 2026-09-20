import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCutoverEnvelopeStore, type CutoverEnvelope, type CutoverEnvelopeStore } from "../../src/release/cutover-envelope";
import { FileCutoverEnvelopeStore } from "../../src/release/cutover-envelope-file-store";

export type WritableEnvelopeStore = CutoverEnvelopeStore & { write(envelope: CutoverEnvelope): void };

/**
 * Both envelope stores, so the handoff contract runs against each.
 *
 * The in-memory one is the reference the protocol was designed against. The
 * file one is what a cutover actually uses, because the envelope has to
 * outlive the database being replaced - and a protocol proved only against a
 * Map has never been asked to survive that.
 */
export const cutoverEnvelopeStores: ReadonlyArray<readonly [string, () => WritableEnvelopeStore]> = [
  ["in-memory", () => new InMemoryCutoverEnvelopeStore()],
  ["file", () => new FileCutoverEnvelopeStore(mkdtempSync(join(tmpdir(), "cutover-envelope-")))],
];
