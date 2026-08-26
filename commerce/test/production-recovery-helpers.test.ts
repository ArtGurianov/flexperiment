import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const stateScript = join(root, "scripts/print-production-recovery-state.sh");
const topologyScript = join(root, "scripts/inspect-release-topology.sh");
const promotionScript = join(root, "scripts/verify-legal-promotion.sh");
const secret = "SUPER_SECRET_TEST_TOKEN_123";
const temporaryDirectories: string[] = [];

afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const sha = (letter: string) => letter.repeat(40);
const validStatus = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  sales_paused: true,
  owner_release_id: `deploy-${sha("a")}`,
  owner_mode: "CONTROLLED_CUTOVER",
  expected: { source_commit: sha("a"), migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "b".repeat(64) },
  runtime: {
    source_commit: sha("a"), worker_source_commit: sha("a"), legal_version: "2026-08-26.1",
    legal_manifest_sha256: "b".repeat(64), current_legal_copies_match: true,
  },
  ...overrides,
});

const readAllFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? readAllFiles(file) : [readFileSync(file, "utf8")];
});

const runState = (scenario: "paused" | "open" | "missing" | "malformed" = "paused", options: { releaseId?: string; token?: boolean; containerMode?: "one" | "zero" | "ambiguous"; curlFails?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-recovery-state-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const curlLog = join(directory, "curl.log");
  mkdirSync(bin); writeFileSync(curlLog, "");
  const curl = join(bin, "curl");
  const docker = join(bin, "docker");
  writeFileSync(curl, [
    "#!/usr/bin/env bash", "set -euo pipefail", "output=''", "for ((i=1; i <= $#; i++)); do", "  if [[ \"${!i}\" == '--output' ]]; then next=$((i + 1)); output=\"${!next}\"; fi", "done",
    "url=\"${!#}\"", "printf '%s\\n' \"$url\" >> \"$CURL_LOG\"", "[[ \"$CURL_FAILS\" == 1 ]] && { echo 'transport failed' >&2; exit 22; }",
    "if [[ \"$url\" == *'/status' ]]; then",
    `  case \"$STATE_SCENARIO\" in paused) body='${validStatus()}' ;; open) body='${validStatus({ sales_paused: false, owner_release_id: null, owner_mode: null, expected: null })}' ;; missing) body='{"sales_paused":true}' ;; malformed) printf '%s' '{bad' > \"$output\"; exit 0 ;; esac`,
    "else body='{\"complete\":true,\"expected\":null,\"reopened_at\":\"2026-08-26T00:00:00Z\"}'; fi", "printf '%s' \"$body\" > \"$output\"",
  ].join("\n"));
  writeFileSync(docker, [
    "#!/usr/bin/env bash", "set -euo pipefail", "case \"$1\" in",
    "  ps) case \"$CONTAINER_MODE\" in one) printf 'id-one\\tproject-commerce-1\\n' ;; ambiguous) printf 'id-one\\tproject-commerce-1\\nid-two\\tother-commerce-1\\n' ;; esac ;;",
    "  exec) printf '%s' \"$DYNAMIC_TOKEN\" ;;", "esac",
  ].join("\n"));
  chmodSync(curl, 0o755); chmodSync(docker, 0o755);
  const args = [stateScript];
  if (options.releaseId) args.push("--release-id", options.releaseId);
  const result = spawnSync("bash", args, {
    cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLIC_API_URL: "https://api.test", CURL_LOG: curlLog,
      STATE_SCENARIO: scenario, CURL_FAILS: options.curlFails ? "1" : "0", CONTAINER_MODE: options.containerMode ?? "one", DYNAMIC_TOKEN: secret,
      ...(options.token === false ? { COMMERCE_RELEASE_CONTROL_TOKEN: "" } : { COMMERCE_RELEASE_CONTROL_TOKEN: secret }),
    },
  });
  return { result, curlLog: readFileSync(curlLog, "utf8"), files: readAllFiles(directory) };
};

const git = (directory: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const createCommit = (directory: string, files: Record<string, string>, message: string) => {
  for (const [name, contents] of Object.entries(files)) {
    const file = join(directory, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, contents);
  }
  git(directory, ["add", "."]); git(directory, ["commit", "-qm", message]);
  return git(directory, ["rev-parse", "HEAD"]);
};

const createGraph = () => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-release-topology-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-q"]); git(directory, ["config", "user.email", "test@example.test"]); git(directory, ["config", "user.name", "Test"]);
  const candidate = createCommit(directory, { "README.md": "candidate\n" }, "candidate");
  const repair = createCommit(directory, { "scripts/controller.ts": "repair\n" }, "repair");
  const controller = createCommit(directory, { "scripts/controller.ts": "controller\n" }, "controller");
  git(directory, ["checkout", "-q", "-B", "unrelated-main", candidate]);
  const unrelatedMain = createCommit(directory, { "frontend/font.css": "font\n" }, "unrelated font");
  git(directory, ["checkout", "-q", repair]);
  const promotion = createCommit(directory, {
    "certification.sh": "certification\n",
    "commerce/legal/production-manifest.json": "{}\n",
    "public/legal/privacy-policy.md": "privacy\n",
    "public/legal/personal-data-consent.md": "consent\n",
  }, "promotion");
  git(directory, ["branch", "-f", "controller", controller]);
  return { directory, candidate, repair, controller, promotion, unrelatedMain };
};

const runTopology = (directory: string, values: { candidate: string; repair: string; controller: string; promotion: string }) =>
  spawnSync("bash", [topologyScript, "--candidate", values.candidate, "--repair", values.repair, "--controller", values.controller, "--promotion", values.promotion], { cwd: directory, encoding: "utf8" });

describe("production recovery state snapshot", () => {
  it("prints a canonical paused-owner snapshot and never leaks the token", () => {
    const { result, curlLog, files } = runState();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ sales_paused: true, owner_release_id: `deploy-${sha("a")}`, expected_source_commit: sha("a"), completion: expect.objectContaining({ complete: true }) }));
    expect(curlLog).toContain("/status"); expect(curlLog).toContain(`/completion/deploy-${sha("a")}`);
    expect(`${result.stdout}${result.stderr}${files.join("\n")}`).not.toContain(secret);
  });

  it("returns deterministic null completion for an open release with no owner", () => {
    const { result, curlLog } = runState("open");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sales_paused: false, owner_release_id: null, completion: null });
    expect(curlLog).not.toContain("/completion/");
  });

  it("queries an explicit completed release after ownership has been released", () => {
    const { result, curlLog } = runState("open", { releaseId: "deploy-known-release" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).completion.complete).toBe(true);
    expect(curlLog).toContain("/completion/deploy-known-release");
  });

  it.each(["missing", "malformed"] as const)("fails closed for %s status data", (scenario) => {
    const { result } = runState(scenario);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("redacts the token and Authorization header when the authenticated GET fails", () => {
    const { result, files } = runState("paused", { curlFails: true });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}${files.join("\n")}`).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).not.toContain("Authorization:");
  });

  it.each(["zero", "ambiguous"] as const)("fails closed for %s commerce-container discovery", (containerMode) => {
    const { result, curlLog } = runState("paused", { token: false, containerMode });
    expect(result.status).toBe(1);
    expect(curlLog).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  });

  it("can read a token from exactly one existing commerce container without exposing it", () => {
    const { result, files } = runState("paused", { token: false, containerMode: "one" });
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}${files.join("\n")}`).not.toContain(secret);
  });
});

describe("read-only release topology and promotion verification", () => {
  it("accepts a direct promotion from repair while controller commits remain separate", () => {
    const graph = createGraph();
    const topology = runTopology(graph.directory, graph);
    expect(topology.status, topology.stderr).toBe(0);
    expect(JSON.parse(topology.stdout)).toMatchObject({ candidate: graph.candidate, repair: graph.repair, controller: graph.controller, promotion: graph.promotion, candidate_is_ancestor_of_repair: true, repair_is_ancestor_of_controller: true, promotion_parent: graph.repair, promotion_parent_is_exact_repair: true, controller_is_ancestor_of_promotion: false });
    expect(spawnSync("git", ["merge-base", "--is-ancestor", graph.unrelatedMain, graph.promotion], { cwd: graph.directory }).status).toBe(1);
    const promotion = spawnSync("bash", [promotionScript, graph.repair, graph.promotion], { cwd: graph.directory, encoding: "utf8" });
    expect(promotion.status, promotion.stderr).toBe(0);
    expect(JSON.parse(promotion.stdout)).toMatchObject({ repair_sha: graph.repair, promotion_sha: graph.promotion, direct_child: true, allowed_scope: true });
  });

  it("allows controller identity to equal repair instead of inventing a controller-ref inequality rule", () => {
    const graph = createGraph();
    const topology = runTopology(graph.directory, { ...graph, controller: graph.repair });
    expect(topology.status, topology.stderr).toBe(0);
    expect(JSON.parse(topology.stdout)).toMatchObject({ repair_is_ancestor_of_controller: true, controller_is_ancestor_of_promotion: true });
  });

  it("rejects a controller-contaminated promotion and unavailable commits", () => {
    const graph = createGraph();
    git(graph.directory, ["checkout", "-q", graph.controller]);
    const contaminated = createCommit(graph.directory, { "public/legal/privacy-policy.md": "contaminated\n" }, "bad promotion");
    const topology = runTopology(graph.directory, { ...graph, promotion: contaminated });
    expect(topology.status).toBe(1); expect(topology.stderr).toContain("PROMOTION_PARENT_INVALID");
    const promotion = spawnSync("bash", [promotionScript, graph.repair, contaminated], { cwd: graph.directory, encoding: "utf8" });
    expect(promotion.status).toBe(1); expect(promotion.stderr).toContain("LEGAL_PROMOTION_PARENT_INVALID");
    for (const invalidPromotion of [sha("f"), "not a revision"]) {
      const unavailable = runTopology(graph.directory, { ...graph, promotion: invalidPromotion });
      expect(unavailable.status).toBe(1); expect(unavailable.stderr).toContain("PROMOTION_COMMIT_UNAVAILABLE");
    }
  });

  it("rejects merge promotions", () => {
    const graph = createGraph();
    git(graph.directory, ["checkout", "-qb", "extra", graph.repair]);
    createCommit(graph.directory, { "public/legal/extra.md": "extra\n" }, "extra");
    git(graph.directory, ["checkout", "-q", "-b", "merge-promotion", graph.repair]);
    createCommit(graph.directory, { "certification.sh": "promotion\n" }, "promotion base");
    git(graph.directory, ["merge", "--no-ff", "-m", "merge promotion", "extra"]);
    const mergePromotion = git(graph.directory, ["rev-parse", "HEAD"]);
    const result = spawnSync("bash", [promotionScript, graph.repair, mergePromotion], { cwd: graph.directory, encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("LEGAL_PROMOTION_PARENT_COUNT_INVALID");
  });

  it.each([".github/workflows/unsafe.yml", "commerce/src/domain.ts", "commerce/migrations/9999.sql", "release-surface-contract.json", "frontend/app/page.tsx", "apps/admin/page.tsx"])("rejects a promotion with forbidden path %s", (forbiddenPath) => {
    const graph = createGraph();
    git(graph.directory, ["checkout", "-q", "-b", "invalid", graph.repair]);
    const invalid = createCommit(graph.directory, { [forbiddenPath]: "forbidden\n" }, "invalid promotion");
    const result = spawnSync("bash", [promotionScript, graph.repair, invalid], { cwd: graph.directory, encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("LEGAL_PROMOTION_SCOPE_INVALID");
  });
});

describe("recovery helpers are operationally read-only", () => {
  it("contains no Git ref, checkout, deployment, or release-control mutation command", () => {
    const scripts = [stateScript, topologyScript, promotionScript].map((file) => readFileSync(file, "utf8"));
    for (const source of scripts) {
      expect(source).not.toMatch(/\bgit\s+(?:push|reset|checkout|switch|branch\s+-f|update-ref|pull|fetch)\b/u);
      expect(source).not.toMatch(/\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE))/iu);
      expect(source).not.toMatch(/release-control\/(?:acquire|pause|expectations|reopen|legal-publish)/u);
      expect(source).not.toMatch(/\bdocker\s+(?:stop|restart|rm)\b/u);
      expect(source).not.toMatch(/recommended_action|RESUMING_[A-Z_]+/u);
    }
    expect(readFileSync(topologyScript, "utf8")).not.toContain("production-deploy");
  });
});
