import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { mintOrdProviderProfile } from "../src/agent-referrals-ord-provider-profile";
import {
  openOrdProviderOperation, recordOrdProviderOperationSubmitted, confirmOrdProviderOperation, recordOrdProviderOperationErirReconciliation, lockOrdProviderOperation,
  currentOrdProviderOperation, OrdProviderOperationError,
} from "../src/agent-referrals-ord-provider-operation";

/**
 * Round-2 P0.1 fix: durable manual provider-OPERATION authority for the
 * four profile kinds - distinct from the immutable profile CONTENT
 * (agent-referrals-ord-provider-profile.test.ts, if any) which describes
 * what Flexperiment's counterparty/platform/contract/media facts ARE, not
 * whether they were ever actually registered/confirmed with VK.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "ord-provider-operation-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  return db;
};

const admin = "admin-1";

describe("openOrdProviderOperation: provider-operation authority (revision chain)", () => {
  it("mints a DRAFT/MUTABLE revision-1 operation pinned to the CURRENT profile of that kind", () => {
    const db = fresh();
    const profile = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation, replayed } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(replayed).toBe(false);
    expect(operation.operation_kind).toBe("COUNTERPARTY");
    expect(operation.revision).toBe(1);
    expect(operation.provider_profile_revision_id).toBe(profile.id);
    expect(operation.local_state).toBe("DRAFT");
    expect(operation.lock_state).toBe("MUTABLE");
  });

  it("refuses when no profile of that kind exists yet", () => {
    const db = fresh();
    expect(() => openOrdProviderOperation(db, admin, "PLATFORM")).toThrow(/AGENT_REFERRALS_ORD_PROVIDER_PROFILE_MISSING/);
  });

  it("is idempotent while still DRAFT", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "CONTRACT", { ref: "C-1" }, "seed");
    const first = openOrdProviderOperation(db, admin, "CONTRACT");
    const second = openOrdProviderOperation(db, admin, "CONTRACT");
    expect(second.replayed).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
  });

  it("refuses under DORMANT", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ord-provider-operation-dormant-")), "commerce.sqlite");
    const db = openDatabase(file); migrate(db); open.push(db);
    expect(() => openOrdProviderOperation(db, admin, "COUNTERPARTY")).toThrow(/AGENT_REFERRALS_FEATURE_DORMANT/);
  });

  it("refuses under SUSPENDED, even completing an already-DRAFT operation", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "MEDIA", { media_ref: "site" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "MEDIA");
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "pause" });
    expect(() => recordOrdProviderOperationSubmitted(db, operation.id, "vk-ext-1", "ev")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
  });
});

describe("submit -> confirm -> CORRECTION_ONLY -> correction -> lock", () => {
  it("the full manual lifecycle", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    const submitted = recordOrdProviderOperationSubmitted(db, operation.id, "vk-ext-1", "ev-submit");
    expect(submitted.local_state).toBe("SUBMITTED");
    expect(submitted.lock_state).toBe("MUTABLE");
    const confirmed = confirmOrdProviderOperation(db, operation.id);
    expect(confirmed.local_state).toBe("CONFIRMED");
    expect(confirmed.lock_state).toBe("CORRECTION_ONLY");

    // A genuine correction: reopen mints revision 2.
    const { operation: reopened, replayed } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(replayed).toBe(false);
    expect(reopened.revision).toBe(2);
    expect(reopened.supersedes_operation_id).toBe(operation.id);
    expect(currentOrdProviderOperation(db, "COUNTERPARTY")!.id).toBe(reopened.id);

    const resubmitted = recordOrdProviderOperationSubmitted(db, reopened.id, "vk-ext-2", "ev-submit-2");
    const reconfirmed = confirmOrdProviderOperation(db, resubmitted.id);
    const locked = lockOrdProviderOperation(db, reconfirmed.id);
    expect(locked.lock_state).toBe("EXTERNALLY_LOCKED");
  });

  it("confirmOrdProviderOperation refuses before a real submission", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(() => confirmOrdProviderOperation(db, operation.id)).toThrow(/AGENT_REFERRALS_ORD_PROVIDER_OPERATION_NOT_SUBMITTED/);
  });

  it("once CORRECTION_ONLY, no raw field edit is legal except the one-way transition to EXTERNALLY_LOCKED", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    recordOrdProviderOperationSubmitted(db, operation.id, "vk-ext-1", "ev");
    const confirmed = confirmOrdProviderOperation(db, operation.id);
    expect(() => db.prepare("UPDATE ord_provider_operations SET evidence_ref = 'x' WHERE id = ?").run(confirmed.id)).toThrow(/ORD_PROVIDER_OPERATION_CORRECTION_ONLY/);
  });

  it("a raw INSERT of revision 2 naming a predecessor that was NOT itself CORRECTION_ONLY (still MUTABLE) is refused", () => {
    const db = fresh();
    const profile = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY"); // stays MUTABLE
    expect(() => db.prepare(`INSERT INTO ord_provider_operations(id, operation_kind, revision, supersedes_operation_id, provider_profile_revision_id, operation_key, local_state, vk_submission_state, vk_external_id, evidence_ref, lock_state, correction_reason, created_by_admin_id)
      VALUES (?, 'COUNTERPARTY', 2, ?, ?, 'op-badpred', 'CONFIRMED', 'SUBMITTED', 'x', 'ev', 'CORRECTION_ONLY', 'bad', 'admin')`)
      .run(randomUUID(), operation.id, profile.id)).toThrow(/ORD_PROVIDER_OPERATION_RELATIONAL_INCONSISTENT/);
  });

  it("a raw INSERT pinning a STALE (superseded) provider profile revision is refused", () => {
    const db = fresh();
    const v1 = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "v1" }, "seed");
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "v2" }, "revision 2"); // now current
    expect(() => db.prepare(`INSERT INTO ord_provider_operations(id, operation_kind, revision, provider_profile_revision_id, operation_key, created_by_admin_id)
      VALUES (?, 'COUNTERPARTY', 1, ?, 'op-stale', 'admin')`).run(randomUUID(), v1.id)).toThrow(/ORD_PROVIDER_OPERATION_RELATIONAL_INCONSISTENT/);
  });

  it("a provider-observed id, once set, can never be overwritten to a different value", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    recordOrdProviderOperationSubmitted(db, operation.id, "vk-ext-1", "ev");
    expect(() => db.prepare("UPDATE ord_provider_operations SET vk_external_id = 'vk-ext-REWRITTEN' WHERE id = ?").run(operation.id)).toThrow(/ORD_PROVIDER_OPERATION_OBSERVED_ID_IMMUTABLE/);
  });

  it("authority columns are DB-immutable even pre-lock", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(() => db.prepare("UPDATE ord_provider_operations SET operation_key = 'different' WHERE id = ?").run(operation.id)).toThrow(/ORD_PROVIDER_OPERATION_AUTHORITY_COLUMNS_IMMUTABLE/);
  });

  it("delete is never legal", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(() => db.prepare("DELETE FROM ord_provider_operations WHERE id = ?").run(operation.id)).toThrow(/ORD_PROVIDER_OPERATION_IMMUTABLE/);
  });

  it("once EXTERNALLY_LOCKED, no UPDATE of any kind is legal", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    recordOrdProviderOperationSubmitted(db, operation.id, "vk-ext-1", "ev");
    confirmOrdProviderOperation(db, operation.id);
    const locked = lockOrdProviderOperation(db, operation.id);
    expect(() => recordOrdProviderOperationErirReconciliation(db, locked.id, "erir-1")).toThrow(/AGENT_REFERRALS_ORD_PROVIDER_OPERATION_LOCKED/);
    expect(() => db.prepare("UPDATE ord_provider_operations SET erir_code = 'x' WHERE id = ?").run(locked.id)).toThrow(/ORD_PROVIDER_OPERATION_TERMINAL_IMMUTABLE/);
  });

  it("refuses lockOrdProviderOperation on a still-MUTABLE operation", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    const { operation } = openOrdProviderOperation(db, admin, "COUNTERPARTY");
    expect(() => lockOrdProviderOperation(db, operation.id)).toThrow(/AGENT_REFERRALS_ORD_PROVIDER_OPERATION_NOT_CORRECTABLE/);
  });
});

describe("errors", () => {
  it("OrdProviderOperationError carries a code and status", () => {
    const err = new OrdProviderOperationError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });

  it("currentOrdProviderOperation returns null when no operation exists yet", () => {
    const db = fresh();
    expect(currentOrdProviderOperation(db, "COUNTERPARTY")).toBeNull();
  });
});
