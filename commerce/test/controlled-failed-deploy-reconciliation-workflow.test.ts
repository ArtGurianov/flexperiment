import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-failed-deploy-reconciliation.yml", "utf8");

const HELD = "deploy-a9ea0107191b6e1abaeb8e7794c600646815faec";
const FALSE_POINTER = "a9ea0107191b6e1abaeb8e7794c600646815faec";
const RUNTIME = "3ab36fdff404dfa8d31207d221c32f93751d3bb4";

/** Pulls a jq program out of the workflow exactly as it will run there. */
const predicateBetween = (start: string, end: string) => {
  const from = workflow.indexOf(start);
  expect(from, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const to = workflow.indexOf(end, from + start.length);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return workflow.slice(from + start.length, to);
};

const jqAdmits = (program: string, input: unknown, args: string[]) =>
  spawnSync("jq", ["-e", ...args, program], { input: JSON.stringify(input), encoding: "utf8" }).status === 0;

const legalHashes = {
  PUBLIC_OFFER: "b".repeat(64),
  PRIVACY_POLICY: "c".repeat(64),
  PD_CONSENT: "d".repeat(64),
  CHECKOUT_DISCLOSURE: "e".repeat(64),
};

/** The recorded incident, exactly as the readout observed it. */
const incident = {
  sales_paused: true,
  owner_release_id: HELD,
  owner_mode: "CONTROLLED_CUTOVER",
  emergency_sales_paused: false,
  expected: {
    source_commit: FALSE_POINTER,
    migration: `inventory-sha256:${"a".repeat(64)}`,
    legal_version: "2026-08-28.1",
    legal_manifest_sha256: "f".repeat(64),
  },
  runtime: {
    source_commit: RUNTIME,
    worker_source_commit: RUNTIME,
    legal_version: "2026-08-28.1",
    legal_manifest_sha256: "f".repeat(64),
    legal_publish_time: "2026-08-31 15:58:55",
    legal_hashes: legalHashes,
    current_legal_copies_match: true,
    worker_started_at: "2026-09-16T04:36:01Z",
    worker_observed_at: "2026-09-16T11:09:49Z",
    worker_last_successful_sweep_at: "2026-09-16T11:09:49Z",
  },
  outbox_authority: { email_dispatch_paused: false, dispatch_owner_release_id: null },
};

describe("controlled failed-deploy reconciliation: shape", () => {
  it("is a one-shot incident recovery, not a general authority", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("push:");
    // The three identities are constants. A caller-supplied target SHA would
    // turn an incident recovery into a way to point production anywhere.
    expect(workflow).toContain(`HELD_RELEASE_ID: "${HELD}"`);
    expect(workflow).toContain(`FALSE_POINTER_SHA: "${FALSE_POINTER}"`);
    expect(workflow).toContain(`PROVEN_RUNTIME_SHA: "${RUNTIME}"`);
    const inputs = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(inputs).toContain("confirm:");
    for (const forbidden of ["target_sha", "source_commit", "release_id", "expected_"]) {
      expect(inputs).not.toContain(`${forbidden}:`);
    }
  });

  it("runs under the cutover lease and the production gate", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("never deploys, never promotes, and never touches the candidate", () => {
    // Capability, not prose: the header comment says "no Coolify webhook", so
    // asserting on the word would pass for the wrong reason.
    for (const forbidden of [
      "controlled-coolify-deploy.sh",
      "secrets.COOLIFY",
      "COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL",
      "COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL",
      "COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL",
      "runtime-candidate:refs/heads",
      "release-control/acquire",
      "release-control/pause",
    ]) {
      expect(workflow).not.toContain(forbidden);
    }
    // The candidate is only ever read, to prove it did not move.
    expect(workflow).toContain("RECONCILE_CANDIDATE_MOVED");
  });

  it("moves the pointer only through the leased CAS primitive", () => {
    expect(workflow).toContain(`scripts/set-production-deploy-ref.sh "$PROVEN_RUNTIME_SHA" "$FALSE_POINTER_SHA"`);
    expect(workflow).not.toContain("--force ");
    expect(workflow).not.toContain("update-ref");
  });

  it("orders the mutations so sales reopen last", () => {
    const expectations = workflow.indexOf("/release-control/expectations");
    const cas = workflow.indexOf("scripts/set-production-deploy-ref.sh \"$PROVEN_RUNTIME_SHA\"");
    const reopen = workflow.indexOf("/release-control/reopen");
    expect(expectations).toBeGreaterThan(0);
    expect(cas).toBeGreaterThan(expectations);
    expect(reopen).toBeGreaterThan(cas);
  });

  it("has no compensating rollback: a failed stage leaves the shop paused", () => {
    // Undoing a half-finished reconciliation is how a recovery becomes a
    // second incident. Every stage fails forward into a safe held state.
    expect(workflow).toContain("no compensating rollback");
    expect(workflow.match(/release-control\/expectations/g) ?? []).toHaveLength(1);
    expect(workflow.match(/release-control\/reopen/g) ?? []).toHaveLength(1);
  });
});

describe("controlled failed-deploy reconciliation: incident seal", () => {
  const program = predicateBetween(
    `jq -e --arg release_id "$HELD_RELEASE_ID" --arg false_sha "$FALSE_POINTER_SHA" --arg runtime_sha "$PROVEN_RUNTIME_SHA" '\n`,
    `' durable-before.json >/dev/null || { echo "RECONCILE_NOT_THE_RECORDED_INCIDENT"`,
  );
  const admits = (status: unknown) =>
    jqAdmits(program, status, ["--arg", "release_id", HELD, "--arg", "false_sha", FALSE_POINTER, "--arg", "runtime_sha", RUNTIME]);

  it("admits the recorded incident", () => {
    expect(admits(incident)).toBe(true);
  });

  it.each([
    ["a different owner", { owner_release_id: "deploy-".padEnd(47, "b") }],
    ["a released owner", { owner_release_id: null }],
    ["sales already open", { sales_paused: false }],
    ["an emergency pause", { emergency_sales_paused: true }],
    ["a rolling owner", { owner_mode: "ROLLING" }],
    ["an expectation already corrected", { expected: { ...incident.expected, source_commit: RUNTIME } }],
    ["a fenced outbox", { outbox_authority: { email_dispatch_paused: true, dispatch_owner_release_id: null } }],
  ])("refuses %s", (_name, overlay) => {
    expect(admits({ ...incident, ...overlay })).toBe(false);
  });

  it.each([
    ["a runtime that has moved", { source_commit: "c".repeat(40) }],
    ["a worker that has not", { worker_source_commit: "c".repeat(40) }],
  ])("refuses %s", (_name, overlay) => {
    expect(admits({ ...incident, runtime: { ...incident.runtime, ...overlay } })).toBe(false);
  });
});

describe("controlled failed-deploy reconciliation: only the commit is untrue", () => {
  const program = predicateBetween(
    "          jq -e '\n            .expected.legal_version == .runtime.legal_version",
    `' durable-before.json >/dev/null || { echo "RECONCILE_EXPECTATION_DELTA_IS_NOT_ONLY_SOURCE_COMMIT"`,
  );
  const admits = (status: unknown) => jqAdmits(`.expected.legal_version == .runtime.legal_version${program}`, status, []);

  it("admits an expectation that differs from the runtime only in the commit", () => {
    expect(admits(incident)).toBe(true);
  });

  it.each([
    ["the legal version", { expected: { ...incident.expected, legal_version: "2026-09-01.1" } }],
    ["the legal manifest", { expected: { ...incident.expected, legal_manifest_sha256: "a".repeat(64) } }],
  ])("refuses a delta in %s, which would make this the wrong repair", (_name, overlay) => {
    expect(admits({ ...incident, ...overlay })).toBe(false);
  });

  it.each([
    ["legal copies drifted", { current_legal_copies_match: false }],
    ["an unpublished legal time", { legal_publish_time: "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP" }],
    ["a missing document hash", { legal_hashes: { ...legalHashes, PD_CONSENT: "" } }],
    ["no worker sweep", { worker_last_successful_sweep_at: "" }],
  ])("refuses reopen evidence with %s", (_name, overlay) => {
    expect(admits({ ...incident, runtime: { ...incident.runtime, ...overlay } })).toBe(false);
  });
});

describe("controlled failed-deploy reconciliation: post-mutation proofs", () => {
  it("proves the expectation moved only where intended", () => {
    const program = predicateBetween(
      `jq -e --slurpfile before durable-before.json --arg release_id "$HELD_RELEASE_ID" --arg runtime_sha "$PROVEN_RUNTIME_SHA" '\n`,
      `' durable-mid.json >/dev/null || { echo "RECONCILE_EXPECTATION_POSTCONDITION_FAILED"`,
    );
    // `before` is slurped from a file in the workflow; inline it here so the
    // same program can be exercised with a crafted pair.
    const withBefore = program.replace(/\$before\[0\]/g, "$b");
    const mid = { ...incident, expected: { ...incident.expected, source_commit: RUNTIME } };
    const args = (b: unknown) => ["--argjson", "b", JSON.stringify(b), "--arg", "release_id", HELD, "--arg", "runtime_sha", RUNTIME];
    expect(jqAdmits(withBefore, mid, args(incident))).toBe(true);
    // The owner must survive the correction, and the three carried fields must
    // be byte-for-byte what they were.
    expect(jqAdmits(withBefore, { ...mid, owner_release_id: null }, args(incident))).toBe(false);
    expect(jqAdmits(withBefore, { ...mid, sales_paused: false }, args(incident))).toBe(false);
    expect(jqAdmits(withBefore, { ...mid, expected: { ...mid.expected, legal_version: "2026-09-01.1" } }, args(incident))).toBe(false);
  });

  it("refuses to reopen if the evidence changed after the pointer moved", () => {
    const program = predicateBetween(
      `jq -e --slurpfile request request.json --arg release_id "$HELD_RELEASE_ID" --arg runtime_sha "$PROVEN_RUNTIME_SHA" '\n`,
      `' durable-prereopen.json >/dev/null || { echo "RECONCILE_REOPEN_EVIDENCE_CHANGED"`,
    );
    const withRequest = program.replace(/\$request\[0\]/g, "$r");
    const request = { expected: { legal_version: "2026-08-28.1", legal_manifest_sha256: "f".repeat(64), legal_hashes: legalHashes } };
    const prereopen = { ...incident, expected: { ...incident.expected, source_commit: RUNTIME } };
    const args = ["--argjson", "r", JSON.stringify(request), "--arg", "release_id", HELD, "--arg", "runtime_sha", RUNTIME];
    expect(jqAdmits(withRequest, prereopen, args)).toBe(true);
    // A legal republish between the CAS and the reopen must stop the run
    // rather than reopen against evidence nobody proved.
    expect(jqAdmits(withRequest, { ...prereopen, runtime: { ...prereopen.runtime, legal_hashes: { ...legalHashes, PUBLIC_OFFER: "9".repeat(64) } } }, args)).toBe(false);
    expect(jqAdmits(withRequest, { ...prereopen, runtime: { ...prereopen.runtime, source_commit: "c".repeat(40) } }, args)).toBe(false);
    expect(jqAdmits(withRequest, { ...prereopen, sales_paused: false }, args)).toBe(false);
  });

  it("proves the incident is closed only when the owner is released", () => {
    const program = predicateBetween(
      `jq -e --arg runtime_sha "$PROVEN_RUNTIME_SHA" '\n            .sales_paused == false`,
      `' durable-after.json >/dev/null || { echo "RECONCILE_FINAL_POSTCONDITION_FAILED"`,
    );
    const full = `.sales_paused == false${program}`;
    const closed = { sales_paused: false, owner_release_id: null, owner_mode: null, reopened_at: "2026-09-16 11:30:00", expected: { source_commit: RUNTIME }, runtime: { source_commit: RUNTIME } };
    const args = ["--arg", "runtime_sha", RUNTIME];
    expect(jqAdmits(full, closed, args)).toBe(true);
    expect(jqAdmits(full, { ...closed, owner_release_id: HELD }, args)).toBe(false);
    expect(jqAdmits(full, { ...closed, owner_mode: "CONTROLLED_CUTOVER" }, args)).toBe(false);
    expect(jqAdmits(full, { ...closed, sales_paused: true }, args)).toBe(false);
    expect(jqAdmits(full, { ...closed, reopened_at: null }, args)).toBe(false);
  });
});
