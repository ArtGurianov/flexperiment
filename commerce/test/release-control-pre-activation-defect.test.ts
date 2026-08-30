import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, type OutboxAuthoritySnapshot, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";
import { fenceEmailDispatch, outboxAuthority } from "../src/outbox-authority";

/**
 * The recovery edge for a defect found AFTER certification and BEFORE the
 * irreversible authority transfer.
 *
 * That window had no controller path in either direction, which is a stranded
 * state rather than a missing convenience:
 *
 *   abort                     refuses any generation that was ever CERTIFIED
 *   runtime-readiness defect  only classifies a PAUSED generation
 *   replacement adoption      requires RECOVERY_REQUIRED
 *
 * So the answer is deliberately narrow rather than a weaker abort: it opens
 * only while attempt authority is still LEGACY and the dispatch fence still
 * belongs to this release, so it cannot walk back anything that actually moved.
 */

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const SOURCE = "a".repeat(40);

/**
 * The real applied set, not two invented filenames.
 *
 * adoptCandidate checks the applied-migration ledger against the inventory as a
 * prefix, so a fixture inventory that does not describe this database refuses
 * the adopt for a reason that has nothing to do with what is being tested.
 */
const MIGRATIONS = (() => {
  const db = openDatabase(":memory:"); migrate(db);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>)
    .map((row) => row.version);
  db.close();
  return Object.fromEntries(versions.map((version, index) => [version, String(index % 10).repeat(64)]));
})();
const legalBaseline = {
  legal_version: "2026-08-26.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
};

const head = (releaseId: string, overrides: Partial<GenerationHead> = {}): GenerationHead => ({
  release_id: releaseId, candidate_generation: 1, source_commit: SOURCE,
  migration_inventory: { files: MIGRATIONS }, legal_baseline: legalBaseline,
  release_family: "test-family", checkout_contract_version: "test-v1", admin_contract_version: "test-v1",
  phase: "PAUSED", phase_sequence: 0, ...overrides,
});

const evidence = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: SOURCE, migration_versions: Object.keys(MIGRATIONS), required_migrations: {},
  worker_source_commit: SOURCE, worker_started_at: null, worker_observed_at: null,
  worker_last_successful_sweep_at: null, legal_version: legalBaseline.legal_version,
  legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes,
  legal_publish_time: "2026-08-26T12:09:17Z", current_legal_copies_match: true,
  migration_source_hashes: MIGRATIONS, ...overrides,
} as ReleaseRuntimeEvidence);

const authority = (overrides: Partial<OutboxAuthoritySnapshot> = {}, releaseId = ""): OutboxAuthoritySnapshot => ({
  attempt_authority: "LEGACY", email_dispatch_paused: true, dispatch_owner_release_id: releaseId, ...overrides,
});

/**
 * The dispatch-target reader release-control calls INSIDE its transaction.
 * Defaults to "valid", which is what every ACTIVATION_REFUSAL case needs.
 */
const target = (defect: string | null = null) => () => defect;

const CERTIFICATION = {
  lease_id: "lease-1", occurrence_id: "11111111-1111-4111-8111-111111111111",
  promo_id: "22222222-2222-4222-8222-222222222222",
  expected_idempotency_key_hash: "3".repeat(64), lease_expires_at: "2026-08-30T12:00:00.000Z",
  status: "CONSUMED" as const,
};

/**
 * Drives a real acquire, then writes the certification phases through the
 * ledger the same way the controller does. Going through replay rather than
 * inserting a head directly is the point: a transition the replay would reject
 * is not a transition the system has.
 */
const certified = () => {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const releaseId = `pre-activation-test:${randomUUID()}`;
  gate.acquireCandidate({ head: head(releaseId) });

  let current = head(releaseId);
  const step = (next: Partial<GenerationHead>) => {
    const to = { ...current, ...next, phase_sequence: current.phase_sequence + 1 } as GenerationHead;
    const details: Record<string, unknown> = {
      schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase,
      from_phase_sequence: current.phase_sequence, head: to,
    };
    if (to.phase === "CERTIFIED") {
      details.certification_evidence = {
        occurrence_id: CERTIFICATION.occurrence_id, promo_id: CERTIFICATION.promo_id,
        order_id: "order-1", payment_id: "payment-1", refund_id: "refund-1",
        price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100,
        captured_kopecks: 100, refunded_kopecks: 100,
      };
    }
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', ?)")
      .run(randomUUID(), releaseId, JSON.stringify(details));
    current = to;
  };
  step({ phase: "DEPLOYED_READ_ONLY" });
  step({ phase: "CERTIFICATION_ONLY", certification: { ...CERTIFICATION, status: "ACTIVE" } });
  step({ phase: "CERTIFICATION_IN_FLIGHT", certification: CERTIFICATION });
  step({ phase: "CERTIFIED", certification: CERTIFICATION });

  const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(releaseId) as V2Event[];
  expect(replayReleaseGenerationChain(events).corrupt, "the fixture itself must replay cleanly").toBeUndefined();
  return { db, gate, releaseId, current };
};

const request = (releaseId: string, current: GenerationHead, overrides: Record<string, unknown> = {}) => ({
  release_id: releaseId, candidate_generation: current.candidate_generation,
  expected_state_hash: releaseStateHash(current),
  defect_class: "ACTIVATION_REFUSAL" as const, defect_code: "OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH",
  ...overrides,
});

describe("pre-activation defect recovery", () => {
  it("moves a certified generation to RECOVERY_REQUIRED", () => {
    const { gate, releaseId, current } = certified();
    const result = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    expect(result.head.phase).toBe("RECOVERY_REQUIRED");
    // The certification binding survives byte for byte: what failed is the step
    // AFTER certification, and the money it moved is not un-moved.
    expect(result.head.certification).toEqual(CERTIFICATION);
  });

  it("produces an event the replay accepts", () => {
    // The seam. A transition the ledger replay rejects is not a transition the
    // system has, however well the method reads - and this is precisely how the
    // certified generation could otherwise be left unrecoverable.
    const { db, gate, releaseId, current } = certified();
    gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(releaseId) as V2Event[];
    const replay = replayReleaseGenerationChain(events);
    expect(replay.corrupt).toBeUndefined();
    expect(replay.head?.phase).toBe("RECOVERY_REQUIRED");
  });

  it("leaves the release gate owned and sales paused", () => {
    // Recovery is not an exit. The epoch keeps the gate so a forward-only
    // replacement can be adopted into it.
    const { db, gate, releaseId, current } = certified();
    gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    expect(db.prepare("SELECT sales_paused, owner_release_id FROM release_sales_gate WHERE singleton = 1").get())
      .toEqual({ sales_paused: 1, owner_release_id: releaseId });
  });

  it("refuses once attempt authority has moved", () => {
    // The load-bearing gate. After the transfer there is no going back, so
    // recovery can only mean forward.
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ attempt_authority: "ATTEMPT" }, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_AUTHORITY_ALREADY_ACTIVATED");
  });

  it("refuses when the dispatch fence is open or held by someone else", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ email_dispatch_paused: false, dispatch_owner_release_id: null }, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_FENCE_NOT_OWNED");
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ dispatch_owner_release_id: "someone-else" }), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_FENCE_NOT_OWNED");
  });

  it("refuses a generation that has not certified", () => {
    // Those already have abort and readiness classification; widening this edge
    // would be the casual abort weakening it exists to avoid.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `pre-activation-test:${randomUUID()}`;
    gate.acquireCandidate({ head: head(releaseId) });
    expect(() => gate.markPreActivationDefect(request(releaseId, head(releaseId)), () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_PHASE_INVALID");
  });

  it("refuses when the candidate under recovery is not the deployed one", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current),
      () => evidence({ worker_source_commit: "9".repeat(40) }), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_CANDIDATE_NOT_DEPLOYED");
  });

  it("refuses an unbounded defect class or code", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { defect_class: "ACTIVATION_STORE" }), () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_INVALID");
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { defect_code: "not a code" }), () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_INVALID");
  });

  it("refuses a stale generation or state hash", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { expected_state_hash: "0".repeat(64) }), () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("RELEASE_STATE_STALE");
  });

  it("reconciles a replay of that exact generation and evidence", () => {
    const { gate, releaseId, current } = certified();
    const first = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    const replayed = gate.markPreActivationDefect(
      request(releaseId, first.head as GenerationHead), () => evidence(), () => authority({}, releaseId), target());
    expect(replayed.head.phase).toBe("RECOVERY_REQUIRED");
    expect(replayed.head.phase_sequence).toBe(first.head.phase_sequence);
  });

  it("refuses to reconcile a replay whose evidence differs", () => {
    // A replay reports what the ledger recorded, not what this request says.
    const { gate, releaseId, current } = certified();
    const first = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    expect(() => gate.markPreActivationDefect(
      request(releaseId, first.head as GenerationHead, { defect_code: "OUTBOX_ACTIVATION_NOT_DRAINED" }),
      () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_EVIDENCE_CONFLICT");
  });

  it("refuses to reconcile a recovery that came from a different edge", () => {
    // The audit blocker. RECOVERY_REQUIRED is reachable through three edges, so
    // reconciling on the phase alone would report a runtime-readiness recovery
    // as a successful replay of an activation defect that was never recorded -
    // which is exactly what the separate ledger kind exists to prevent.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `pre-activation-test:${randomUUID()}`;
    gate.acquireCandidate({ head: head(releaseId) });
    const recovered = gate.markRuntimeReadinessDefect({
      release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(head(releaseId)),
      readiness_component: "PROVIDER_READINESS", error_class: "PROVIDER_NETWORK", error_code: "ECONNRESET",
    }, () => evidence());
    expect(recovered.head.phase).toBe("RECOVERY_REQUIRED");

    expect(() => gate.markPreActivationDefect(
      request(releaseId, recovered.head as GenerationHead), () => evidence(), () => authority({}, releaseId), target()))
      .toThrow("PRE_ACTIVATION_DEFECT_NOT_RECORDED");
  });

  it("evaluates the dispatch target inside its own transaction", () => {
    // The reader is called by release-control, under the same BEGIN IMMEDIATE
    // that appends the edge - not by the caller beforehand. The fence does not
    // serialize message-level changes (seam 4 permits suppression and
    // supersession throughout), so evidence read outside this transaction can
    // be stale by the time the ledger records it.
    const { db, gate, releaseId, current } = certified();
    let calledInTransaction: boolean | null = null;
    gate.markPreActivationDefect(
      request(releaseId, current, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId),
      () => { calledInTransaction = db.inTransaction; return "CERTIFICATION_DISPATCH_TARGET_MISSING"; },
    );
    expect(calledInTransaction).toBe(true);
  });

  it("records the code the store proved, not the one the caller sent", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(
      request(releaseId, current, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "CERTIFICATION_DISPATCH_TARGET_MISSING" }),
      () => evidence(), () => authority({}, releaseId), target("CERTIFICATION_DISPATCH_TARGET_ALREADY_STARTED")))
      .toThrow("PRE_ACTIVATION_DEFECT_CODE_NOT_DERIVED");
  });

  it("refuses to classify a target the store says is fine", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(
      request(releaseId, current, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId), target(null)))
      .toThrow("PRE_ACTIVATION_DEFECT_TARGET_IS_VALID");
  });

  it("replays a committed target defect after the target has been repaired", () => {
    // The decisive replay proof. A committed transition must stay replayable
    // from its durable provenance: classify TARGET_MISSING, lose the response,
    // the mail then appears, retry. Re-deriving present state would refuse a
    // transition that has already happened.
    const { gate, releaseId, current } = certified();
    const recovered = gate.markPreActivationDefect(
      request(releaseId, current, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId), target("CERTIFICATION_DISPATCH_TARGET_MISSING"));
    expect(recovered.head.phase).toBe("RECOVERY_REQUIRED");

    // The target is now perfectly valid; the replay must still reconcile.
    const replayed = gate.markPreActivationDefect(
      request(releaseId, recovered.head as GenerationHead, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId), target(null));
    expect(replayed.head.phase).toBe("RECOVERY_REQUIRED");
    expect(replayed).toMatchObject({ recorded_defect: { defect_code: "CERTIFICATION_DISPATCH_TARGET_MISSING" } });
  });

  it("does not consult the target reader at all on a replay", () => {
    // Stronger than the previous test: the reader must not even be called, or a
    // reader that throws on a repaired store would break replay.
    const { gate, releaseId, current } = certified();
    const recovered = gate.markPreActivationDefect(
      request(releaseId, current, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId), target("CERTIFICATION_DISPATCH_TARGET_MISSING"));
    gate.markPreActivationDefect(
      request(releaseId, recovered.head as GenerationHead, { defect_class: "CERTIFICATION_DISPATCH_TARGET_INVALID", defect_code: "" }),
      () => evidence(), () => authority({}, releaseId),
      () => { throw new Error("the target reader must not run on a replay"); });
  });

  it("exposes an aborted epoch's head, which the live-candidate read cannot", () => {
    // Once abort commits, candidateHead() no longer sees the epoch: terminal
    // phases are excluded from the active set and its historical fallback
    // selects only COMPLETE. Every later stage of the cutover resolves its
    // source from the head, so without an exact-release read the ABORTED-only
    // recovery unfence is unreachable across runs - and so is abort's own
    // lost-response reconciliation.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `pre-activation-test:${randomUUID()}`;
    gate.acquireCandidate({ head: head(releaseId) });
    gate.abortCandidate({
      release_id: releaseId, candidate_generation: 1,
      expected_state_hash: releaseStateHash(head(releaseId)), reason: "operator abandoned the cutover",
    }, () => evidence());

    expect(gate.candidateHead().head?.release_id).not.toBe(releaseId);
    const exact = gate.releaseHead(releaseId);
    expect(exact.head).toMatchObject({ release_id: releaseId, phase: "ABORTED", source_commit: SOURCE });
    expect(exact.state_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses an exact-release read for a release that has no history", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    expect(() => gate.releaseHead("never-existed")).toThrow("RELEASE_HEAD_NOT_FOUND");
  });

  it("hands the generation to a forward-only replacement", () => {
    // The whole point: RECOVERY_REQUIRED is what adoptCandidate accepts, so the
    // certified-but-unactivatable generation now has somewhere to go.
    const { gate, releaseId, current } = certified();
    const recovered = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId), target());
    const replacement = "9".repeat(40);
    const adopted = gate.adoptCandidate({
      head: { ...head(releaseId), candidate_generation: 2, source_commit: replacement, phase: "PAUSED", phase_sequence: 0 },
      expected_generation: 1, from_sha: SOURCE, expected_state_hash: releaseStateHash(recovered.head as GenerationHead),
    });
    expect(adopted.head).toMatchObject({ candidate_generation: 2, source_commit: replacement, phase: "PAUSED" });
  });
});

/**
 * This is intentionally not an extension of pre-activation recovery.  The
 * authority has moved, so the only safe direction is ATTEMPT containment then
 * a forward replacement; these tests exercise that separate edge directly.
 */
describe("post-activation email-provider defect recovery", () => {
  const exactDefect = () => ({
    order_id: "order-certified", unfenced_at: "2026-08-30 10:00:00.000",
    ticket_attempt: {
      outbox_id: "ticket-1", attempt_id: "attempt-1", attempt_no: 1,
      outcome: "KNOWN_FAILED", started_at: "2026-08-30T10:00:01.000Z",
      failure_code: "UNISENDER_HTTP_REJECTED", provider_error_code: "1588",
    },
    exact: true,
  });

  const postRequest = (releaseId: string, current: GenerationHead, authorityRevision: number) => ({
    release_id: releaseId, candidate_generation: current.candidate_generation,
    expected_state_hash: releaseStateHash(current), expected_authority_revision: authorityRevision,
  });

  const postAuthority = (db: ReturnType<typeof openDatabase>, releaseId: string) => {
    const authority = outboxAuthority(db);
    return { ...authority, drained: true, dispatch_owner_release_id: releaseId, dispatch_owner_generation: null };
  };

  it("contains open ATTEMPT with the real epoch CAS, then atomically classifies after drain", () => {
    const { db, gate, releaseId, current } = certified();
    // Simulate the durable result of activation/unfence: it is open, ATTEMPT,
    // and at revision 6. The primitive itself must create the re-fence edge.
    db.prepare("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT', email_dispatch_paused = 0, dispatch_owner_release_id = NULL, dispatch_owner_generation = NULL, revision = 6 WHERE singleton = 1").run();
    const fenced = fenceEmailDispatch(db, { expected_revision: 6, reason: "contain provider refusal" }, { release_id: releaseId, generation: null });
    expect(fenced).toMatchObject({ attempt_authority: "ATTEMPT", email_dispatch_paused: true, dispatch_owner_release_id: releaseId, revision: 7 });

    const recovered = gate.markPostActivationEmailProviderDefect(
      postRequest(releaseId, current, 7), () => postAuthority(db, releaseId), exactDefect);
    expect(recovered.head).toMatchObject({ phase: "RECOVERY_REQUIRED", certification: CERTIFICATION });
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(releaseId) as V2Event[];
    expect(replayReleaseGenerationChain(events)).toMatchObject({ head: { phase: "RECOVERY_REQUIRED", certification: CERTIFICATION } });
    expect(events.at(-1)?.details_json).toContain('"kind":"POST_ACTIVATION_EMAIL_PROVIDER_DEFECT"');
  });

  it("replays from already-fenced ATTEMPT without consuming another authority revision", () => {
    const { db, gate, releaseId, current } = certified();
    db.prepare("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT', email_dispatch_paused = 0, dispatch_owner_release_id = NULL, dispatch_owner_generation = NULL, revision = 6 WHERE singleton = 1").run();
    fenceEmailDispatch(db, { expected_revision: 6, reason: "contain provider refusal" }, { release_id: releaseId, generation: null });
    const once = gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), () => postAuthority(db, releaseId), exactDefect);
    const revision = outboxAuthority(db).revision;
    const replayed = gate.markPostActivationEmailProviderDefect(
      postRequest(releaseId, once.head as GenerationHead, revision),
      () => { throw new Error("authority reader must not run for a committed replay"); },
      () => { throw new Error("defect reader must not run for a committed replay"); },
    );
    expect(replayed.head).toEqual(once.head);
    expect(outboxAuthority(db).revision).toBe(revision);
  });

  it("refuses foreign ownership, a stale authority revision, and undrained containment", () => {
    const { gate, releaseId, current } = certified();
    const base = { attempt_authority: "ATTEMPT" as const, email_dispatch_paused: true, dispatch_owner_release_id: releaseId, dispatch_owner_generation: null, revision: 7, drained: true };
    expect(() => gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), () => ({ ...base, dispatch_owner_release_id: "other" }), exactDefect))
      .toThrow("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_FENCE_NOT_OWNED");
    expect(() => gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 8), () => base, exactDefect))
      .toThrow("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_AUTHORITY_REVISION_STALE");
    expect(() => gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), () => ({ ...base, drained: false }), exactDefect))
      .toThrow("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_DISPATCH_NOT_DRAINED");
  });

  it("refuses a non-exact attempt, a pre-unfence attempt, and a different terminal provider failure", () => {
    const { gate, releaseId, current } = certified();
    const authority = () => ({ attempt_authority: "ATTEMPT" as const, email_dispatch_paused: true, dispatch_owner_release_id: releaseId, dispatch_owner_generation: null, revision: 7, drained: true });
    for (const defective of [
      { ...exactDefect(), exact: false },
      { ...exactDefect(), ticket_attempt: { ...exactDefect().ticket_attempt, started_at: "2026-08-30T09:59:59.000Z" }, exact: false },
      { ...exactDefect(), ticket_attempt: { ...exactDefect().ticket_attempt, outcome: "ACCEPTED", failure_code: null }, exact: false },
      { ...exactDefect(), ticket_attempt: { ...exactDefect().ticket_attempt, provider_error_code: "1589" }, exact: false },
    ]) {
      expect(() => gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), authority, () => defective))
        .toThrow("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT_EVIDENCE_INVALID");
    }
  });

  it("cannot commit an evidence event without its recovery phase", () => {
    const { db, gate, releaseId, current } = certified();
    db.exec(`CREATE TRIGGER reject_post_activation_defect BEFORE INSERT ON release_sales_gate_events
      WHEN NEW.details_json LIKE '%POST_ACTIVATION_EMAIL_PROVIDER_DEFECT%'
      BEGIN SELECT RAISE(ABORT, 'test atomic rollback'); END;`);
    const authority = () => ({ attempt_authority: "ATTEMPT" as const, email_dispatch_paused: true, dispatch_owner_release_id: releaseId, dispatch_owner_generation: null, revision: 7, drained: true });
    expect(() => gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), authority, exactDefect)).toThrow();
    expect(gate.releaseHead(releaseId).head?.phase).toBe("CERTIFIED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE details_json LIKE '%POST_ACTIVATION_EMAIL_PROVIDER_DEFECT%'").get()).toEqual({ n: 0 });
  });

  it("keeps complete unreachable after the terminal provider refusal", () => {
    const { gate, releaseId, current } = certified();
    const authority = () => ({ attempt_authority: "ATTEMPT" as const, email_dispatch_paused: true, dispatch_owner_release_id: releaseId, dispatch_owner_generation: null, revision: 7, drained: true });
    const recovered = gate.markPostActivationEmailProviderDefect(postRequest(releaseId, current, 7), authority, exactDefect);
    expect(() => gate.completeCandidate({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(recovered.head as GenerationHead) }, () => evidence()))
      .toThrow("RELEASE_STATE_STALE");
  });
});
