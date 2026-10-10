import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { deployFoundation, deployNormalCanary, validateCheckout, verifyRuntime } from "./deployment.mjs";
import { ownerRpc } from "./owner-transport.mjs";

const sha = process.env.V2_SOURCE_SHA;
const host = process.env.V2_OWNER_HOST;
const key = process.env.V2_OWNER_SSH_KEY_FILE;
const rpcHash = process.env.V2_RPC_SHA256;
const repository = process.env.GITHUB_REPOSITORY;
const mode = process.env.V2_DEPLOYMENT_MODE ?? "foundation";
const shaPattern = /^[0-9a-f]{40}$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  if (!["foundation", "normal-canary"].includes(mode)) throw new Error("V2_MODE_TARGET_REFUSED");
  if (!shaPattern.test(sha ?? "") || !/^[a-zA-Z0-9@._-]+$/.test(host ?? "")
    || (process.env.GITHUB_ACTIONS === "true" && !key) || !/^[0-9a-f]{64}$/.test(rpcHash ?? "") || repository !== "ArtGurianov/flexperiment") throw new Error("V2_WORKFLOW_CONFIG_REQUIRED");
  validateCheckout(sha,
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim());
  const script = `/root/flexperiment-v2-owner/controllers/${sha}/owner-rpc.py`;
  const rpc = async (message) => {
    // Payload is stdin, not remote-shell text. Verify the transferred helper on every call.
    const command = `test "$(sha256sum ${script} | cut -d ' ' -f 1)" = ${rpcHash} && python3 ${script}`;
    return ownerRpc(message, [...(key ? ["-i", key] : []), "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", host, command], {
        timeout: 90_000, maxBuffer: 2_000_000,
      });
  };
  const { apps } = await rpc({ operation: "config" });
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("V2_GITHUB_ADMISSION_UNAVAILABLE");
    return response.json();
  };
  const api = (method, path, body) => rpc({ operation: "api", method, path, body });
  const runtime = (target, options = {}) => rpc({ operation: "runtime", target, ...options });
  const waitRuntime = async (target, source, mounts, previous) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const result = await runtime(target);
      if (result?.pending) { await pause(5_000); continue; }
      // Converged malformed/security state is terminal, not a reason for retries.
      verifyRuntime(result, source, mounts, mode);
      if (!previous || result.startedAt !== previous.startedAt) return result;
      await pause(5_000);
    }
    throw new Error("V2_RUNTIME_CONVERGENCE_TIMEOUT");
  };
  const deploy = async (target, source) => {
    const { deployment } = await rpc({ operation: "deploy", target, sha: source, mode });
    const deadline = Date.now() + 1_800_000;
    while (Date.now() < deadline) {
      const status = await rpc({ operation: "deployment", target, deployment });
      if (["failed", "cancelled", "cancelled-by-user", "error"].includes(status.status)) throw new Error("V2_COOLIFY_DEPLOY_FAILED");
      if (status.status === "finished") {
        if (status.commit !== source) throw new Error("V2_COOLIFY_DEPLOYED_DIFFERENT_SOURCE");
        return;
      }
      await pause(10_000);
    }
    throw new Error("V2_COOLIFY_DEPLOY_TIMEOUT");
  };
  const casRef = async (target, source) => {
    if (!['canary', 'production'].includes(target)) throw new Error("V2_REF_SCOPE_REFUSED");
    const ref = `refs/heads/commerce-v2-${target}-deploy`;
    const previous = execFileSync("git", ["ls-remote", "origin", ref], { encoding: "utf8" }).split("\t")[0].trim();
    if (previous) {
      if (!shaPattern.test(previous)) throw new Error("V2_REF_MALFORMED");
      execFileSync("git", ["fetch", "--no-tags", "origin", ref], { stdio: "ignore" });
      execFileSync("git", ["merge-base", "--is-ancestor", previous, source], { stdio: "ignore" });
    }
    // An independently advanced ref cannot be overwritten after the observation.
    execFileSync("git", ["push", "origin", `${source}:${ref}`, `--force-with-lease=${ref}:${previous}`], { stdio: "ignore" });
  };
  const controller = mode === "foundation" ? deployFoundation : deployNormalCanary;
  const proofs = await controller(sha, { apps, github, api, casRef, deploy, runtime, waitRuntime,
    snapshot: (target) => rpc({ operation: "snapshot", target }),
    backupRuntime: (target) => rpc({ operation: "backup-runtime", target }),
    restart: (target) => rpc({ operation: "restart", target }),
    storage: (target, command, marker) => rpc({ operation: "storage", target, command, marker }),
    archiveBackup: (target, backup) => rpc({ operation: "archive", target, filename: backup.filename }),
    record: (target, proof) => rpc({ operation: "record", target, proof }),
  });
  const report = JSON.stringify({ schema: mode === "foundation" ? "flexperiment.v2-foundation-proof/1" : "flexperiment.v2-normal-canary-deployment/1", proofs });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `V2 ${mode} deployment (no F9, no payments; normal-canary is API-only, not live auth qualification).\n\n\`\`\`json\n${report}\n\`\`\`\n`);
}

run().catch((error) => {
  console.error(/^V2_[A-Z_]+$/.test(error.message ?? "") ? error.message : "V2_FOUNDATION_STOP");
  console.error("No automatic deploy retry/rollback; inspect owner journal"); process.exitCode = 1;
});
