import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BootstrapRollbackError, canonicalRollbackSha256,
  type BootstrapRollbackReceipt, type BootstrapRollbackReceiptStore, type BootstrapRollbackStage,
} from "./bootstrap-rollback";

const stages: readonly BootstrapRollbackStage[] = ["PREPARED", "RESTORED", "COMPLETED"];
const id = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_ID_INVALID");
  return value;
};

/** Durable receipt store outside the SQLite file a reverse handoff destroys. */
export class FileBootstrapRollbackReceiptStore implements BootstrapRollbackReceiptStore {
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }

  read(rollbackId: string): BootstrapRollbackReceipt | undefined {
    const path = this.path(rollbackId);
    if (!existsSync(path)) return undefined;
    let receipt: BootstrapRollbackReceipt;
    try { receipt = JSON.parse(readFileSync(path, "utf8")) as BootstrapRollbackReceipt; }
    catch { throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_UNREADABLE", rollbackId); }
    if (receipt.envelope.rollbackId !== rollbackId || !stages.includes(receipt.stage) || !canonicalRollbackSha256(receipt.envelope)) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_INVALID", rollbackId);
    }
    return receipt;
  }

  write(receipt: BootstrapRollbackReceipt): void {
    const target = this.path(receipt.envelope.rollbackId);
    if (existsSync(target)) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_EXISTS");
    this.durableWrite(target, receipt);
  }

  advance(rollbackId: string, stage: BootstrapRollbackStage): BootstrapRollbackReceipt {
    const receipt = this.read(rollbackId);
    if (!receipt) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_NOT_FOUND", rollbackId);
    const from = stages.indexOf(receipt.stage);
    const to = stages.indexOf(stage);
    if (to < from) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_REGRESSION", `${receipt.stage} -> ${stage}`);
    if (to > from + 1) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_SKIP", `${receipt.stage} -> ${stage}`);
    if (to === from) return receipt;
    const target = this.path(rollbackId);
    this.durableWrite(target, { ...receipt, stage });
    return { ...receipt, stage };
  }

  private path(rollbackId: string) { return join(this.directory, `${id(rollbackId)}.json`); }

  private durableWrite(target: string, receipt: BootstrapRollbackReceipt) {
    const temporary = `${target}.${process.pid}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, target); }
    catch (error) { unlinkSync(temporary); throw error; }
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
