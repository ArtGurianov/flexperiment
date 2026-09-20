import { describe, expect, it } from "vitest";
import {
  InMemoryCertificationRunStore, commandPermitted, enterCleanup, planRecovery,
  type CertificationRun,
} from "../../src/certification/run";

const base: CertificationRun = {
  runId: "run", revision: 1, releaseSha: "a".repeat(40), phase: "NEW", direction: "NORMAL",
  startedAt: "2026-09-20T00:00:00.000Z",
};
const opened = (over: Partial<CertificationRun> = {}) => {
  const runs = new InMemoryCertificationRunStore();
  return { runs, run: runs.create({ ...base, ...over }) };
};
const cancelling: CertificationRun = {
  ...base, phase: "TICKET_EMAIL_DELIVERED", direction: "FINANCIAL_EFFECT_POSSIBLE", occurrenceId: "occ",
  orderId: "order", statusId: "status", paymentId: "pay", bookingId: "booking", ticketId: "ticket",
  humanTicketVerifiedAt: "2026-09-20T01:00:00.000Z",
  pendingCommand: { kind: "CANCEL_BOOKING", idempotencyKey: "cancel-key", bookingId: "booking" },
};

describe("the run as an authority", () => {
  it("lets exactly one of two runners advance it", () => {
    // Both read revision 1 and both believe they may act. Silently accepting
    // the second writer is how two runners each believe they own the money.
    const { runs, run } = opened();

    const winner = runs.update(run.runId, run.revision, { phase: "OCCURRENCE_CREATED" });

    expect(winner.revision).toBe(run.revision + 1);
    expect(() => runs.update(run.runId, run.revision, { phase: "OCCURRENCE_PUBLISHED" })).toThrow("CERTIFICATION_RUN_REVISION_CONFLICT");
    expect(runs.load(run.runId)?.phase).toBe("OCCURRENCE_CREATED");
  });

  it("refuses to move backwards in either direction it is monotonic in", () => {
    const { runs, run } = opened();
    const advanced = runs.update(run.runId, run.revision, { phase: "OCCURRENCE_OPEN", direction: "CLEANUP_STARTED" });
    expect(() => runs.update(advanced.runId, advanced.revision, { phase: "NEW" })).toThrow("CERTIFICATION_RUN_PHASE_REGRESSED");
    expect(() => runs.update(advanced.runId, advanced.revision, { direction: "NORMAL" })).toThrow("CERTIFICATION_RUN_DIRECTION_REGRESSED");
  });

  it("keeps the certified revision immutable for the life of the run", () => {
    const { runs, run } = opened();
    expect(() => runs.update(run.runId, run.revision, { releaseSha: "b".repeat(40) } as never)).toThrow("CERTIFICATION_RUN_RELEASE_IMMUTABLE");
  });
});

describe("entering cleanup", () => {
  it("keeps a financial command exactly as it was armed", () => {
    // An ambiguous cancellation followed by an emergency close is what this
    // exists for: the catalogue has to shut, and the exact command and key
    // still have to be there, because that is what a reconciliation needs to
    // find out whether a customer was charged.
    const { runs, run } = opened(cancelling);

    const cleaning = enterCleanup(runs, run);

    expect(cleaning.direction).toBe("CLEANUP_STARTED");
    expect(cleaning.pendingCommand).toEqual(cancelling.pendingCommand);
    expect(cleaning.supersededCommand ?? null).toBeNull();
  });

  it("retires a catalogue-opening intent but keeps its record", () => {
    // It must never execute again; its key is still how a reconciliation finds
    // out whether the request got through.
    const command = { kind: "OPEN_SALES" as const, idempotencyKey: "open-key", occurrenceId: "occ", expectedRevision: 3 };
    const { runs, run } = opened({ phase: "OCCURRENCE_PUBLISHED", occurrenceId: "occ", pendingCommand: command });

    const cleaning = enterCleanup(runs, run);

    expect(cleaning.pendingCommand ?? null).toBeNull();
    expect(cleaning.supersededCommand).toEqual({ command, reason: "CLEANUP_SUPERSEDED_CATALOGUE_OPENING" });
  });

  it("is idempotent once the run is already travelling that way", () => {
    const { runs, run } = opened({ direction: "CLEANUP_STARTED" });
    expect(enterCleanup(runs, run)).toBe(run);
  });
});

describe("what a run is permitted to do", () => {
  it("closes the catalogue direction permanently once cleanup has begun", () => {
    const cleaning = { ...base, direction: "CLEANUP_STARTED" as const, phase: "OCCURRENCE_PUBLISHED" as const };
    expect(commandPermitted(cleaning, "OPEN_SALES")).toBe("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
    expect(commandPermitted({ ...cleaning, phase: "OCCURRENCE_CREATED" }, "PUBLISH_OCCURRENCE")).toBe("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
  });

  it("still lets a checkout be re-issued after cleanup, as a lookup", () => {
    // By the time it was armed the request may already have created an order
    // and spent the capability, with only the response lost. Re-issuing it is
    // how the run finds out which; the server refuses to create a new one, and
    // that refusal is itself the answer.
    const cleaning = { ...base, direction: "CLEANUP_STARTED" as const, phase: "CHECKOUT_SUBMITTING" as const };
    expect(commandPermitted(cleaning, "CREATE_CHECKOUT")).toBeUndefined();
  });

  it("still permits finishing the money after cleanup has begun", () => {
    // A captured payment must still be refunded.
    expect(commandPermitted({ ...cancelling, direction: "CLEANUP_STARTED" }, "CANCEL_BOOKING")).toBeUndefined();
  });

  it("refuses a command offered at a phase it does not belong to", () => {
    // Its effect has already been consumed by a later step. Replaying it there
    // is how one certification produces two bookings.
    expect(commandPermitted({ ...cancelling, phase: "REFUND_SUCCEEDED" }, "CANCEL_BOOKING")).toBe("CERTIFICATION_COMMAND_PHASE_INVALID");
  });
});

describe("recovery planning", () => {
  it("refuses every branch when production is not the revision the run began on", () => {
    expect(planRecovery(cancelling, false)).toEqual({ kind: "BLOCKED_BASELINE" });
  });

  it("replays the interrupted command rather than composing a new one", () => {
    expect(planRecovery(cancelling, true)).toEqual({ kind: "REPLAY_PENDING", command: cancelling.pendingCommand });
  });

  it("sends an unfinished cleanup to the catalogue, whatever phase it reached first", () => {
    expect(planRecovery({ ...base, phase: "OCCURRENCE_OPEN", direction: "CLEANUP_STARTED", occurrenceId: "occ" }, true)).toEqual({ kind: "CLEAN_CATALOGUE" });
    expect(planRecovery({ ...base, phase: "REFUND_EMAIL_DELIVERED" }, true)).toEqual({ kind: "CLEAN_CATALOGUE" });
  });

  it("routes a settled run to its remaining step", () => {
    expect(planRecovery({ ...base, phase: "OCCURRENCE_CLEANED", direction: "CATALOGUE_CLEAN" }, true)).toEqual({ kind: "WRITE_MANIFEST" });
    expect(planRecovery({ ...base, phase: "COMPLETE", direction: "CATALOGUE_CLEAN" }, true)).toEqual({ kind: "REPORT_COMPLETE" });
    expect(planRecovery({ ...base, phase: "PAYMENT_PROVEN" }, true)).toEqual({ kind: "CONTINUE" });
  });
});
