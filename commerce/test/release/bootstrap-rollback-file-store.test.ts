import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileBootstrapRollbackReceiptStore } from "../../src/release/bootstrap-rollback-file-store";
import type { BootstrapRollbackReceipt, BootstrapRollbackStage } from "../../src/release/bootstrap-rollback";

const predecessor = "c".repeat(40);
const receipt = (stage: BootstrapRollbackStage = "RESERVED"): BootstrapRollbackReceipt => ({
  stage,
  intent: {
    rollbackId: "rollback-1", cutoverId: "cutover-1", successorSessionId: "session-1",
    targetSha: "d".repeat(40), forwardEnvelopeSha256: "e".repeat(64),
    predecessorDatabase: { ref: "/state/archive/predecessor.sqlite", sha256: "a".repeat(64) },
    preDeployTopology: {
      runtime: { frontend: predecessor, admin: predecessor, commerce: predecessor, worker: predecessor },
      controlPlane: { productionDeployRefSha: predecessor },
    },
    createdAt: "2026-09-21T00:00:00.000Z",
  },
});

describe("external bootstrap rollback receipt", () => {
  it("survives a recreated store and advances only one durable stage at a time", () => {
    const directory = mkdtempSync(join(tmpdir(), "rollback-receipt-"));
    const first = new FileBootstrapRollbackReceiptStore(directory);
    first.write(receipt());
    const recovered = new FileBootstrapRollbackReceiptStore(directory);
    expect(recovered.read("rollback-1")?.stage).toBe("RESERVED");
    expect(recovered.advance("rollback-1", "DATABASE_RESTORED", {
      successorDatabase: { ref: "/state/archive/successor.sqlite", sha256: "b".repeat(64) },
    }).stage).toBe("DATABASE_RESTORED");
    expect(recovered.advance("rollback-1", "REF_RESTORED").stage).toBe("REF_RESTORED");
  });

  it("refuses overwrite, stage skipping, traversal ids, and a corrupted durable digest", () => {
    const directory = mkdtempSync(join(tmpdir(), "rollback-receipt-"));
    const store = new FileBootstrapRollbackReceiptStore(directory);
    store.write(receipt());
    expect(() => store.write(receipt())).toThrow("BOOTSTRAP_ROLLBACK_RECEIPT_EXISTS");
    expect(() => store.advance("rollback-1", "REF_RESTORED")).toThrow("BOOTSTRAP_ROLLBACK_STAGE_SKIP");
    expect(() => store.read("../escape")).toThrow("BOOTSTRAP_ROLLBACK_ID_INVALID");

    const path = join(directory, "rollback-1.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { receipt: BootstrapRollbackReceipt; sha256: string };
    writeFileSync(path, JSON.stringify({ ...parsed, receipt: { ...parsed.receipt, stage: "COMPLETED" } }));
    expect(() => store.read("rollback-1")).toThrow("BOOTSTRAP_ROLLBACK_RECEIPT_UNREADABLE");
  });
});
