import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileBootstrapRollbackReceiptStore } from "../../src/release/bootstrap-rollback-file-store";

const receipt = (stage: "PREPARED" | "RESTORED" | "COMPLETED" = "PREPARED") => ({
  stage,
  envelope: {
    rollbackId: "rollback-1", cutoverId: "cutover-1", successorSessionId: "session-1",
    predecessorDatabase: { ref: "/state/archive/predecessor.sqlite", sha256: "a".repeat(64) },
    successorDatabase: { ref: "/state/archive/successor.sqlite", sha256: "b".repeat(64) },
    preDeployTopology: { runtime: { frontend: "c".repeat(40), admin: "c".repeat(40), commerce: "c".repeat(40), worker: "c".repeat(40) }, controlPlane: { productionDeployRefSha: "c".repeat(40) } },
    successorTopology: { runtime: { frontend: "d".repeat(40), admin: "d".repeat(40), commerce: "d".repeat(40), worker: "d".repeat(40) }, controlPlane: { productionDeployRefSha: "d".repeat(40) } },
    createdAt: "2026-09-21T00:00:00.000Z", expiresAt: "2026-09-21T01:00:00.000Z", nonce: "n",
  },
});

describe("external bootstrap rollback receipt", () => {
  it("survives a recreated store and advances only one durable stage at a time", () => {
    const directory = mkdtempSync(join(tmpdir(), "rollback-receipt-"));
    const first = new FileBootstrapRollbackReceiptStore(directory);
    first.write(receipt());
    const recovered = new FileBootstrapRollbackReceiptStore(directory);
    expect(recovered.read("rollback-1")?.stage).toBe("PREPARED");
    expect(recovered.advance("rollback-1", "RESTORED").stage).toBe("RESTORED");
    expect(recovered.advance("rollback-1", "COMPLETED").stage).toBe("COMPLETED");
  });

  it("refuses overwrite, stage skipping and path traversal ids", () => {
    const store = new FileBootstrapRollbackReceiptStore(mkdtempSync(join(tmpdir(), "rollback-receipt-")));
    store.write(receipt());
    expect(() => store.write(receipt())).toThrow("BOOTSTRAP_ROLLBACK_RECEIPT_EXISTS");
    expect(() => store.advance("rollback-1", "COMPLETED")).toThrow("BOOTSTRAP_ROLLBACK_STAGE_SKIP");
    expect(() => store.read("../escape")).toThrow("BOOTSTRAP_ROLLBACK_ID_INVALID");
  });
});
