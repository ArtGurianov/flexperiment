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

  it("refuses to fence a runtime that already carries the attempt store", () => {
    // The fence stage runs against the runtime being REPLACED. An attempt store
    // there means the stages are being run out of order.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_FENCE_RUNTIME_ALREADY_ADVANCED");
    expect(workflow).toContain(".attempts == null");
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

  it("proves dispatch under attempt authority, and refuses a vacuous proof", () => {
    // "The fence is lifted" is control plane. This is the data-plane fact: a
    // message enqueued under LEGACY, given its attempt row by activation, is
    // claimed, sent and settled IN THE ATTEMPT STORE.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_NO_BACKLOG_TO_PROVE_DISPATCH");
    expect(workflow).toContain("(.attempts.settled_accepted > $accepted)");
    expect(workflow).toContain('[[ "$UNSETTLED_BEFORE_UNFENCE" -ge 1 ]]');
    // Captured BEFORE the fence lifts, or the comparison races the worker.
    expect(at("UNSETTLED_BEFORE_UNFENCE=$(jq")).toBeLessThan(at("/v1/internal/release-control/outbox-dispatch/unfence"));
  });

  it("keeps a way out of an aborted cutover that left the fence held", () => {
    // Abort releases the release gate and deliberately does not lift the fence.
    // Without a recovery unfence, mail would stay stopped with no stage able to
    // resume it - and that is exactly the stranded fence this programme chose
    // not to build a takeover for.
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_UNFENCE_MODE_REQUIRED");
    expect(workflow).toContain("ATTEMPT_AUTHORITY_CUTOVER_RECOVERY_UNFENCE_ON_ACTIVATED_STORE");
    expect(workflow).toContain('unfence_mode=recovery');
    expect(workflow).toContain("ABORT_DISPATCH_FENCED=");
    // The dispatch proof is skipped on the recovery path: nothing was
    // activated, so there is no ATTEMPT dispatch to prove.
    expect(workflow).toContain("env.INPUT_UNFENCE_MODE == 'activated'");
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
