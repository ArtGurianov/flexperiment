import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PATH_ = ".github/workflows/controlled-outbox-attempt-authority-cutover.yml";
const workflow = readFileSync(PATH_, "utf8");
const at = (needle: string) => {
  const index = workflow.indexOf(needle);
  expect(index, `workflow contains ${needle}`).toBeGreaterThan(-1);
  return index;
};

/**
 * The controller for migration 0041 and the LEGACY -> ATTEMPT transfer.
 *
 * Its ordering carries a constraint no previous epoch had: one step is
 * irreversible. Everything that can be proven while rolling back is still
 * possible has to happen before it, and everything the fence stops has to be
 * resumed before the epoch that owns the fence goes away.
 *
 *   fence    before prepare    0041 rebuilds outbox_authority and drops and
 *                              recreates both 0040 guards; doing that with mail
 *                              in flight is the hazard the migration names
 *   certify  before activate   a real 1-RUB order proves the candidate binary
 *                              while abort is still available
 *   unfence  before complete   the fence is owned by an epoch, completing ends
 *                              the epoch, and stranded-fence takeover is
 *                              deliberately not built
 */
describe("controlled outbox attempt-authority cutover", () => {
  it("runs from the production environment on the shared cutover concurrency group", () => {
    // One group across every controlled cutover: two epochs driving production
    // release state concurrently is the thing the group exists to prevent.
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("admits every stage at the validator, not merely in the options list", () => {
    // The 0040 seam defect, restated: `options:` listed abort while the first
    // dispatcher rejected the value, so the exit path looked present and was
    // unreachable. Both lists are checked against each other here.
    const validator = workflow.split("\n").map((line) => line.trim()).filter((line) => line.includes("STAGE_INVALID"));
    expect(validator).toHaveLength(1);
    const options = workflow.match(/options: \[(fence[^\]]*)\]/);
    expect(options).not.toBeNull();
    for (const stage of options![1].split(",").map((value) => value.trim())) {
      expect(validator[0], `the stage validator admits ${stage}`).toContain(stage);
    }
    for (const stage of ["fence", "prepare", "certify", "activate", "unfence", "complete", "abort"]) {
      expect(options![1]).toContain(stage);
    }
  });

  it("fences before it deploys, and refuses to deploy otherwise", () => {
    // Not merely stage ordering advice in a runbook: prepare reads the durable
    // fence and exits when this epoch does not hold it.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_FENCE_REQUIRED_BEFORE_PREPARE");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_FENCE_REQUIRED_BEFORE_PREPARE"))
      .toBeLessThan(at("scripts/set-production-deploy-ref.sh"));
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_FENCE_REQUIRED_BEFORE_PREPARE"))
      .toBeLessThan(at("scripts/controlled-coolify-deploy.sh"));
  });

  it("proves the fence drained, and drained twice", () => {
    // One drained observation is compatible with a send that started and
    // finished between two reads; the fence's actual claim is that nothing NEW
    // can begin, and only a second observation at an unchanged revision speaks
    // to that.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_NOT_DRAINED");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_NOT_QUIESCENT");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_NOT_DRAINED"))
      .toBeLessThan(at("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_NOT_QUIESCENT"));
  });

  it("refuses to fence only once authority has actually moved", () => {
    // The attempt store's PRESENCE is deliberately not a refusal, though it
    // reads like a natural one.
    //
    // An aborted cutover leaves 0041 applied and the attempt-aware runtime
    // deployed with authority never moved. That is a legitimate resting state,
    // and rolling the runtime back is not an escape from it: a pre-0041 binary
    // halts its own sweep on an unknown applied migration. Refusing to fence
    // there would mean no future cutover could ever start.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_FENCE_AUTHORITY_NOT_LEGACY");
    expect(workflow).not.toContain("ATTEMPT_AUTHORITY_CUTOVER_FENCE_RUNTIME_ALREADY_ADVANCED");
    expect(workflow).toContain("FENCE_RUNTIME_HAS_ATTEMPT_STORE=");
    // Inside the fence stage the attempt store may be REPORTED and never gated
    // on: a line mentioning it that also exits is the refusal coming back.
    const stage = workflow.slice(at("Fence email dispatch on the deployed runtime"),
      at("Prove dispatch drained and stays drained"));
    for (const line of stage.split("\n").filter((candidate) => candidate.includes(".attempts"))) {
      expect(line, "the attempt store is reported, not gated on").not.toMatch(/exit 1/);
    }
  });

  it("binds the dispatch epoch to the release id with no generation", () => {
    // The fence is held across the whole cutover, including a forward-only
    // recovery that bumps the candidate generation. A generation-bound epoch
    // would stop owning its own fence the moment a recovery happened, and the
    // only way out of that is the takeover this programme has not built.
    expect(workflow).toContain('echo "RELEASE_ID=outbox-attempt-authority-v1:$target_sha"');
    expect(workflow).toContain("generation: null");
    expect(workflow).not.toContain("generation: $generation");
    // Stable across a replacement recovery: built from target_sha, never from
    // the effective source.
    expect(workflow).not.toContain('RELEASE_ID=outbox-attempt-authority-v1:$effective_sha');
  });

  it("requires a runtime that can receive the authority it is about to be given", () => {
    // Applying 0041 to a binary with no attempt-aware writers would produce a
    // store nothing can consume.
    const guard = workflow.match(/ACTIVATION_MIN_SHA=([0-9a-f]{40})/);
    expect(guard).not.toBeNull();
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATION_CAPABLE_RUNTIME_REQUIRED");
    // The pin must name a real commit that actually carries the activation
    // module, not a plausible-looking hex string.
    const files = execFileSync("git", ["show", "--name-only", "--format=", guard![1]], { encoding: "utf8" });
    expect(files).toContain("commerce/src/outbox-activation.ts");
  });

  it("proves 0041 arrived without moving the authority it widens", () => {
    // The migration changes what is representable, never what is true. The
    // control row must come through the RENAME-and-rebuild byte for byte -
    // fence, owner and revision - because a rebuild that reset to defaults
    // would silently unfence production mail mid-cutover.
    expect(workflow).toContain('$authority.attempt_authority == "LEGACY"');
    expect(workflow).toContain("$authority.revision == $revision");
    expect(workflow).toContain("$authority.email_dispatch_paused == true");
    expect(workflow).toContain("$authority.dispatch_owner_release_id == $release_id");
    // And the append-only audit stream kept its past across the events rebuild.
    expect(workflow).toContain('$authority.last_event.action == "DISPATCH_FENCED"');
  });

  it("treats the presence of the attempt store as proof the candidate is live", () => {
    // The runtime being replaced cannot produce this field at all, which makes
    // its presence a stronger liveness signal than any version string.
    expect(workflow).toContain("($authority.attempts | type == \"object\")");
  });

  it("does not require a converged store before activation", () => {
    // Historical messages have no attempt row until activation backfills one.
    // Asserting convergence at prepare would mean the flip had already
    // happened, so the counts are reported and not gated.
    expect(workflow).toContain("PRE_ACTIVATION_STORE=");
    expect(at("PRE_ACTIVATION_STORE=")).toBeLessThan(at("ATTEMPT_AUTHORITY_CUTOVER_STORE_NOT_CONVERGED"));
  });

  it("activates only a certified candidate", () => {
    // The irreversible step happens last among the provable ones: a certified
    // candidate has transacted a real 1-RUB order on this exact binary.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATE_REQUIRES_CERTIFIED_CANDIDATE");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATE_REQUIRES_CERTIFIED_CANDIDATE"))
      .toBeLessThan(at("/v1/internal/release-control/outbox-authority/activate"));
  });

  it("refreshes an expired certification lease, and only an expired one", () => {
    // Found in production: prepare activated a 300s lease, the operator stopped
    // to inspect the resulting state as designed, and the window closed before
    // the payment. The runtime already had the primitive - CERTIFICATION_ONLY ->
    // DEPLOYED_READ_ONLY revokes the allowlist row transactionally - but the
    // controller had no branch that used it, so a correct pause left the
    // cutover unable to proceed without a manual endpoint call.
    //
    // The dangerous half is the converse: refreshing a LIVE lease would revoke
    // the window an operator is part-way through paying against, every time
    // prepare is rerun. So the reset is gated on proven expiry.
    const stage = workflow.slice(at("Activate or reconcile the certification lease"),
      at("Record consumed certification evidence"));
    expect(stage).toContain("CERTIFICATION_LEASE_EXPIRED=");
    expect(stage).toContain('from_phase: "CERTIFICATION_ONLY"');
    expect(stage).toContain('to_phase: "DEPLOYED_READ_ONLY"');
    // The reset must be SENT, not merely composed. Asserting the body's
    // contents proves the request was built; only this proves it is posted -
    // and it has to precede the fresh lease, since activation refuses while a
    // lease is still ACTIVE.
    const resetPost = stage.indexOf('--data-binary @lease-reset.json "$PUBLIC_API_URL/v1/internal/release-control/candidates/phase"');
    const activatePost = stage.indexOf("/v1/internal/release-control/candidates/certification/activate");
    expect(resetPost).toBeGreaterThan(-1);
    expect(activatePost).toBeGreaterThan(-1);
    expect(resetPost).toBeLessThan(activatePost);
    // A malformed string is neither live nor expired: parsing fails closed
    // before the phase-reset POST can revoke the old lease. This exact finite
    // check is intentional mutation coverage: replacing it with a truthy stub
    // makes this assertion fail, and reintroduces the NaN-as-expired defect.
    const expiryRefusal = stage.indexOf("ATTEMPT_AUTHORITY_CUTOVER_CERTIFICATION_LEASE_EXPIRY_INVALID");
    expect(stage).toContain("const t = Date.parse(process.argv[1]);");
    expect(stage).toContain("Number.isFinite(t)");
    expect(expiryRefusal).toBeGreaterThan(-1);
    expect(expiryRefusal).toBeLessThan(resetPost);
    expect(stage).toContain('[[ "$status" == ACTIVE && "$lease_state" == EXPIRED ]]');
    // Proven expired before anything is revoked, and parsed rather than
    // compared as text - the lease carries an offset-bearing ISO timestamp.
    expect(stage).toContain('t > Date.now() ? "LIVE" : "EXPIRED"');
    expect(stage).not.toMatch(/lease_expires_at["']?\s*[<>]\s*["']?\$\(date/);
    // The CAS presents the exact generation, phase sequence and state hash.
    expect(stage).toContain("expected_state_hash: $current[0].state_hash");
    expect(stage).toContain("phase_sequence: $current[0].head.phase_sequence");
    // And the revocation is proven before a fresh lease is minted.
    expect(stage).toContain('.head.phase == "DEPLOYED_READ_ONLY" and .head.certification.status == "REVOKED"');
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_CERTIFICATION_LEASE_RESET_INVALID"))
      .toBeLessThan(at("/v1/internal/release-control/candidates/certification/activate"));
  });

  it("resets only the fixture it was asked for", () => {
    // A reset revokes a real lease. Doing that to a binding this run did not
    // request would destroy someone else's certification window.
    const stage = workflow.slice(at("Activate or reconcile the certification lease"),
      at("Record consumed certification evidence"));
    expect(stage).toContain("ATTEMPT_AUTHORITY_CUTOVER_CERTIFICATION_FIXTURE_MISMATCH");
    expect(stage).toContain(".head.certification.occurrence_id == $occurrence");
    expect(stage).toContain(".head.certification.promo_id == $promo");
    expect(stage).toContain(".head.certification.expected_idempotency_key_hash == $key_hash");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_CERTIFICATION_FIXTURE_MISMATCH"))
      .toBeLessThan(at("CERTIFICATION_LEASE_EXPIRED="));
  });

  it("keeps the certification order's mail queued behind the fence", () => {
    // Two properties at once: no mail escapes mid-cutover, and the queued
    // messages become the backlog the dispatch proof consumes after unfence.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_CERTIFY_FENCE_INVALID");
    expect(workflow).toContain(".outbox_authority.email_dispatch_paused == true and");
  });

  it("reads the activation audit line back from the durable stream", () => {
    // Not from the response of the transaction that wrote it: the controller is
    // supposed to be verifying that transaction from outside.
    expect(workflow).toContain('.last_event.action == "AUTHORITY_ACTIVATED"');
    expect(workflow).toContain(".last_event.revision == $revision");
    expect(workflow).toContain(".last_event.owner_generation == null");
  });

  it("requires the resulting revision, and tolerates an idempotent replay", () => {
    expect(workflow).toContain("expected_revision=$((previous_revision + 1))");
    expect(workflow).toContain('[[ "$replayed" == "true" ]] || expected_revision=$((previous_revision + 1))');
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATION_REPLAY=1");
  });

  it("requires activation to leave dispatch fenced", () => {
    // Resuming mail is a separate act by a separate stage on separate evidence.
    const activation = workflow.slice(at("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATION_STATE_INVALID") - 1_400,
      at("ATTEMPT_AUTHORITY_CUTOVER_ACTIVATION_STATE_INVALID"));
    expect(activation).toContain('.attempt_authority == "ATTEMPT"');
    expect(activation).toContain(".email_dispatch_paused == true");
  });

  it("requires a converged store after activation, by the shared defect keys", () => {
    // `to_entries | map(.value == 0) | all` deliberately covers every key the
    // runtime reports rather than a list copied into the workflow: a defect
    // added to STORE_DEFECTS is then gated here without touching this file.
    expect(workflow).toContain("(.attempts.defects | to_entries | map(.value == 0) | all)");
    expect(workflow).toContain(".attempts.attempts >= .attempts.messages");
    expect(workflow).toContain(".attempts.leased == 0");
  });

  it("binds the dispatch proof to the exact certified order, not to a population count", () => {
    // "settled_accepted went up" passes for the wrong reason: a late provider
    // callback settling an unrelated older SEND_UNKNOWN increments the same
    // counter, so a broken ATTEMPT dispatch path reads as green.
    expect(workflow).toContain("/v1/internal/release-control/certification-dispatch/$RELEASE_ID");
    expect(workflow).toContain(".dispatched_after_unfence == true");
    expect(workflow).not.toContain(".attempts.settled_accepted >");
    // And the order is never named by the workflow - the runtime resolves it
    // from the durable ledger, so an operator cannot substitute another order.
    expect(workflow).not.toContain("INPUT_CERTIFICATION_ORDER_ID\" > dispatch");
    const proof = workflow.slice(at("Prove dispatch actually runs under attempt authority"),
      at("ATTEMPT_AUTHORITY_CUTOVER_ATTEMPT_DISPATCH_NOT_OBSERVED"));
    expect(proof).not.toContain("INPUT_CERTIFICATION_ORDER_ID");
  });

  it("checks the proof target exists BEFORE the irreversible step", () => {
    // Existence of the backlog is knowable while the transfer is still
    // reversible, so by this epoch's own rule it belongs before the one-way
    // CAS - not discovered missing after it.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_NO_QUEUED_CERTIFICATION_MAIL");
    expect(workflow).toContain(".queued_unstarted == true");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_NO_QUEUED_CERTIFICATION_MAIL"))
      .toBeLessThan(at("/v1/internal/release-control/outbox-authority/activate"));
    // Skipped on a replay, where the backlog has legitimately been dispatched.
    expect(workflow).toContain('if [[ "$replay_run" == 0 ]]; then');
  });

  it("re-proves dispatch from durable evidence before completing", () => {
    // The unfence CAS commits before its dispatch poll runs, so a failed poll
    // leaves ATTEMPT + dispatch open + CERTIFIED. Without this, complete would
    // accept that state and finish an epoch whose only data-plane proof failed.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_PROOF_MISSING_BEFORE_COMPLETE");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_PROOF_MISSING_BEFORE_COMPLETE"))
      .toBeLessThan(at("/v1/internal/release-control/candidates/complete"));
  });

  it("drives post-prepare stages from the durable source, not the dispatch input", () => {
    // Every run starts with effective = target and replacement_sha is accepted
    // only on prepare, so after a forward recovery a later stage would be
    // looking at the ORIGINAL sha and would refuse the generation it exists to
    // drive. The release identity stays derived from the initial target; only
    // the runtime source comes from durable state.
    expect(workflow).toContain("Resolve the effective runtime source from durable candidate state");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_EFFECTIVE_SOURCE_RELEASE_MISMATCH");
    expect(workflow).toContain('echo "EFFECTIVE_TARGET_SHA=$resolved"');
    // It must run before anything that binds to the source.
    expect(at("Resolve the effective runtime source from durable candidate state"))
      .toBeLessThan(at("Bind source migration and surface contracts"));
    // And never on the two stages that legitimately predate a durable head.
    expect(workflow).toContain("if: env.INPUT_STAGE != 'fence' && env.INPUT_STAGE != 'prepare'");
  });

  it("enforces forward-only replacement in git, not only in the generation counter", () => {
    // adoptCandidate checks generation, state hash and the applied-migration
    // prefix; it has no ancestry concept, so an unrelated or older tree would
    // otherwise satisfy it.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_REPLACEMENT_NOT_FORWARD_ONLY");
    expect(workflow).toContain('git merge-base --is-ancestor "$recovering_from" "$EFFECTIVE_TARGET_SHA"');
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_REPLACEMENT_NOT_REACHABLE_FROM_CONTROLLER");
  });

  it("reconciles an adopt whose response was lost", () => {
    // Adopt is a CAS: a lost response leaves it committed and the rerun unable
    // to tell, which would otherwise retry into RELEASE_STATE_STALE forever.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_ADOPT_REPLAY=");
  });

  it("recovers a certified candidate whose activation refused", () => {
    // The window that had no controller path in either direction: abort refuses
    // any generation that was ever CERTIFIED, readiness classification only
    // handles PAUSED, and replacement adoption requires RECOVERY_REQUIRED.
    expect(workflow).toContain("classify_pre_activation_defect");
    expect(workflow).toContain("/v1/internal/release-control/candidates/pre-activation-defect");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_PRE_ACTIVATION_NOT_RECOVERABLE");
    // Narrower than weakening abort: only while nothing irreversible happened.
    const stage = workflow.slice(at("Classify a defect found after certification and before activation"),
      at("ATTEMPT_AUTHORITY_CUTOVER_PRE_ACTIVATION_TRANSITION_INVALID"));
    expect(stage).toContain('.attempt_authority == "LEGACY"');
    expect(stage).toContain(".email_dispatch_paused == true");
    expect(stage).toContain(".dispatch_owner_release_id == $release_id");
    expect(stage).toContain('.head.phase == "CERTIFIED"');
  });

  it("keeps a way out of an aborted cutover that left the fence held", () => {
    // Abort releases the release gate and deliberately does not lift the fence.
    // Without a recovery unfence, mail would stay stopped with no stage able to
    // resume it - and that is exactly the stranded fence this programme chose
    // not to build a takeover for.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_UNFENCE_MODE_REQUIRED");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_RECOVERY_UNFENCE_ON_ACTIVATED_STORE");
    // A LEGACY store is not sufficient: mid-cutover the store is also LEGACY,
    // and opening dispatch there resumes mail under a half-migrated epoch and
    // strands the run, because the fence stage then refuses an already-advanced
    // runtime. The candidate must actually have let go.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_RECOVERY_UNFENCE_CANDIDATE_STILL_LIVE");
    // The property is "no live release candidate", not "the head says ABORTED".
    // The fence predates the candidate, so an operator who fences and then
    // cancels has nothing to abort - an ABORTED-only rule strands that state
    // with mail stopped and no exit. RECOVERY_REQUIRED is still excluded,
    // because it deliberately KEEPS the gate for its replacement prepare.
    const recovery = workflow.slice(at("Resume dispatch under the same epoch"), at("Prove dispatch actually runs"));
    expect(recovery).toContain(".owner_release_id == null and .sales_paused == false");
    expect(recovery).toContain('(.head.phase | IN("ABORTED", "COMPLETE"))');
    expect(recovery).not.toContain('.head.phase == "ABORTED"\' recovery-head.json');
    expect(workflow).toContain('unfence_mode=recovery');
    expect(workflow).toContain("ABORT_DISPATCH_FENCED=");
    // The dispatch proof is skipped on the recovery path: nothing was
    // activated, so there is no ATTEMPT dispatch to prove.
    expect(workflow).toContain("env.INPUT_UNFENCE_MODE == 'activated'");
  });

  it("resolves terminal epochs through the exact-release head read", () => {
    // candidateHead() answers "what is the LIVE candidate": terminal phases are
    // excluded and its historical fallback selects only COMPLETE, so once abort
    // commits the epoch is invisible there and the forward stages could not
    // resolve their own source.
    const resolver = workflow.slice(at("Resolve the effective runtime source from durable candidate state"),
      at("Bind source migration and surface contracts"));
    expect(resolver).toContain("/candidates/head/$RELEASE_ID");
  });

  it("never requires the candidate's own endpoint to recover a pre-candidate state", () => {
    // The bootstrap seam. prepare acquires generation 1 against the OLD binary
    // and deploys afterwards, so a failure in between leaves an epoch whose
    // only recovery path would otherwise need a runtime that never arrived -
    // and the fence is taken before any candidate exists at all.
    //
    // So the exact-release read, which ships WITH the candidate, must not gate
    // either recovery stage.
    expect(workflow).toContain("env.INPUT_STAGE != 'abort' && env.INPUT_STAGE != 'unfence'");
    const recovery = workflow.slice(at("Resume dispatch under the same epoch"), at("Prove dispatch actually runs"));
    expect(recovery).not.toContain("/candidates/head/$RELEASE_ID");
    expect(recovery).toContain("/v1/admin/release-control/candidates/head");
    // Abort prefers the exact read and falls back, rather than requiring it.
    const abort = workflow.slice(at("Abort a still-reversible candidate"), at("Complete only a certified"));
    expect(abort).toContain("if api \"$PUBLIC_API_URL/v1/internal/release-control/candidates/head/$RELEASE_ID\"");
    expect(abort).toContain("exact_head=0");
    expect(abort).toContain("/v1/admin/release-control/candidates/head");
    expect(abort).toContain("ABORT_REPLAY=no-live-candidate");
  });

  it("does not short-circuit the pre-activation replay on phase alone", () => {
    // Three edges reach RECOVERY_REQUIRED. Exiting on the phase would report a
    // runtime-readiness or public-frontend recovery as a successful replay of
    // an activation defect that was never recorded - the exact audit property
    // the separate ledger kind exists to preserve.
    const stage = workflow.slice(at("Classify a defect found after certification and before activation"),
      at("Recovered to RECOVERY_REQUIRED"));
    expect(stage).toContain("ATTEMPT_AUTHORITY_CUTOVER_PRE_ACTIVATION_DEFECT_REPLAY=1");
    // The request is posted on both branches: the answer comes from the ledger.
    expect(stage.slice(stage.indexOf("PRE_ACTIVATION_DEFECT_REPLAY=1")))
      .toContain("/v1/internal/release-control/candidates/pre-activation-defect");
    expect(stage).not.toContain("PRE_ACTIVATION_DEFECT_REPLAY=1\"\n            exit 0");
  });

  it("names a code only for the class that has one", () => {
    // CERTIFICATION_DISPATCH_TARGET_INVALID exists because NO activation
    // refusal was produced, so there is no code to name and the runtime derives
    // one from its own evidence instead of trusting the caller.
    expect(workflow).toContain("ACTIVATION_REFUSAL|CERTIFICATION_DISPATCH_TARGET_INVALID");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_PRE_ACTIVATION_CODE_FORBIDDEN");
    expect(workflow).toContain('if $defect_code == "" then {} else {defect_code: $defect_code} end');
  });

  it("does not claim certify is reversible by abort", () => {
    // abortCandidate refuses any generation that was ever CERTIFIED, and
    // prepare activates the lease from DEPLOYED_READ_ONLY - so the generation
    // leaves abort's reach before certify is ever dispatched. The operator-
    // facing header must not preserve a premise the state machine disproves.
    const header = workflow.slice(0, at("on:"));
    expect(header).not.toContain("certify    reversible");
    expect(header).toContain("abort is NOT");
    expect(header).toContain("RECOVERY_REQUIRED   the epoch still owns the release and KEEPS the fence");
  });

  it("refuses to complete while dispatch is still fenced", () => {
    // This epoch's terminal guard, with no counterpart in the 0040 cutover.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_MUST_BE_RESUMED_BEFORE_COMPLETE");
    expect(workflow).toContain(".outbox_authority.email_dispatch_paused == false and");
    expect(at("ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_MUST_BE_RESUMED_BEFORE_COMPLETE"))
      .toBeLessThan(at("/v1/internal/release-control/candidates/complete"));
  });

  it("keeps the emergency latch ordering of the 0040 epoch", () => {
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_EMERGENCY_LATCH_SET_TOO_EARLY");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_EMERGENCY_LATCH_BLOCKS_CERTIFICATION");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_EMERGENCY_LATCH_REQUIRED_BEFORE_COMPLETE");
    // The controller observes the latch and refuses; it never sets or clears
    // it. A release controller holding admin credentials could also refund,
    // cancel and mutate.
    expect(workflow).not.toContain("/v1/admin/emergency-sales/");
  });

  it("carries no admin mutation credential and never publishes legal state", () => {
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_ACTIVE_MANIFEST_ALREADY_PROMOTED");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_CURRENT_LEGAL_COPIES_CHANGED");
    expect(workflow).not.toContain("/legal-publish");
  });

  it("moves the deployment pointer only through the guarded script", () => {
    // Never a plain force push, and never an ad-hoc ref update.
    expect(workflow).toContain("scripts/set-production-deploy-ref.sh");
    expect(workflow).not.toContain("git push --force ");
    expect(workflow).not.toContain("git update-ref");
  });

  it("keeps the controller commit and the deployment source distinct identities", () => {
    expect(workflow).toContain("CONTROLLER_SHA: ${{ github.sha }}");
    expect(workflow).toContain('git merge-base --is-ancestor "$target_sha" "$CONTROLLER_SHA"');
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$EFFECTIVE_TARGET_SHA"');
  });

  it("parses as shell, every step", () => {
    // These blocks only ever execute against production, mid-cutover, so a
    // syntax error in one is discovered at the worst possible moment. Parsing
    // them here costs nothing and is the only check that runs before then.
    //
    // `bash -n` reads a script without running it: no API call, no deploy. The
    // blocks are extracted by indentation rather than through a YAML parser so
    // this test needs no dependency the repository does not already have.
    const lines = workflow.split("\n");
    const blocks: string[] = [];
    for (const [index, line] of lines.entries()) {
      const opener = line.match(/^(\s*)run: \|\s*$/);
      if (!opener) continue;
      const body: string[] = [];
      for (const candidate of lines.slice(index + 1)) {
        if (candidate.trim() !== "" && !candidate.startsWith(`${opener[1]}  `)) break;
        body.push(candidate.slice(opener[1].length + 2));
      }
      blocks.push(body.join("\n"));
    }
    expect(blocks.length).toBeGreaterThan(10);
    // Every input reaches the shell as an environment variable, never as a
    // GitHub expression interpolated into the script - which is both why these
    // blocks are parseable in isolation and why an input cannot inject shell.
    for (const block of blocks) expect(block).not.toContain("${{");

    const directory = mkdtempSync(join(tmpdir(), "cutover-shell-"));
    for (const [index, block] of blocks.entries()) {
      const file = join(directory, `step-${index}.sh`);
      writeFileSync(file, block);
      expect(() => execFileSync("bash", ["-n", file], { stdio: "pipe" }), `run block ${index}`).not.toThrow();
    }
  });

  it("surfaces every refusal as a named code", () => {
    // A cutover that fails with a bare exit status costs an operator the one
    // thing they need at that moment. Checked per REFUSAL BLOCK rather than per
    // line, because a multi-line guard puts its code on an earlier line than
    // its exit - a line-local check passes on shape rather than on the property.
    const lines = workflow.split("\n");
    const unnamed = lines.flatMap((line, index) => {
      if (!/(^|[;&|\s])exit 1\b/.test(line)) return [];
      // The awk pipeline exits its own subprocess; its code follows the block.
      if (line.includes("awk ")) return [];
      const block = lines.slice(Math.max(0, index - 4), index + 2).join("\n");
      return /ATTEMPT_AUTHORITY_CUTOVER_[A-Z0-9_]+/.test(block) ? [] : [`${index + 1}: ${line.trim()}`];
    });
    expect(unnamed).toEqual([]);
  });
});
