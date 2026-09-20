import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The canonical deploy pointer: a git ref the deployment system already
 * follows, moved only by compare-and-set.
 *
 * Coolify's three applications track this branch. That makes it the control
 * plane, and it is part of what a cutover has to be able to put back - a
 * runtime restored to the old commits while the ref still names the new one is
 * not a production that was left alone, it is one waiting to move again.
 *
 * Every move is a lease. `--force-with-lease=<ref>:<expected>` refuses if the
 * ref is no longer where the caller believed, which is the only thing that
 * makes two controllers safe; a bare force push would let the loser of a race
 * overwrite the winner and never learn it had.
 */

export class DeployRefError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type DeployRefOptions = {
  readonly remote?: string;
  readonly ref?: string;
  readonly cwd?: string;
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>;
};

const SHA = /^[a-f0-9]{40}$/;

const defaultGit = async (args: readonly string[], cwd: string): Promise<string> => {
  try {
    const { stdout } = await run("git", [...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new DeployRefError("DEPLOY_REF_GIT_FAILED", `${args[0]}: ${detail.split("\n")[0]}`);
  }
};

export class ProductionDeployRefStore {
  readonly #remote: string;
  readonly #ref: string;
  readonly #cwd: string;
  readonly #git: (args: readonly string[], cwd: string) => Promise<string>;

  constructor(options: DeployRefOptions = {}) {
    this.#remote = options.remote ?? "origin";
    this.#ref = options.ref ?? "refs/heads/production-deploy";
    this.#cwd = options.cwd ?? process.cwd();
    this.#git = options.git ?? defaultGit;
  }

  /** Where the deployment system would deploy from right now. */
  async read(): Promise<string> {
    const output = await this.#git(["ls-remote", this.#remote, this.#ref], this.#cwd);
    const [line] = output.split("\n").filter(Boolean);
    if (!line) throw new DeployRefError("DEPLOY_REF_ABSENT", this.#ref);
    const sha = line.split(/\s+/)[0];
    if (!SHA.test(sha)) throw new DeployRefError("DEPLOY_REF_MALFORMED", sha);
    return sha;
  }

  /**
   * Moves the pointer, or refuses.
   *
   * The target is fetched and its existence proved locally first: pushing a
   * commit the remote cannot resolve would leave the ref naming nothing, and
   * discovering that after the push is discovering it too late.
   */
  async compareAndSet(expectedSha: string, targetSha: string): Promise<string> {
    if (!SHA.test(expectedSha)) throw new DeployRefError("DEPLOY_REF_EXPECTED_INVALID", expectedSha);
    if (!SHA.test(targetSha)) throw new DeployRefError("DEPLOY_REF_TARGET_INVALID", targetSha);
    if (expectedSha === targetSha) return expectedSha;

    await this.#git(["fetch", "--no-tags", this.#remote, targetSha], this.#cwd);
    await this.#git(["cat-file", "-e", `${targetSha}^{commit}`], this.#cwd);

    try {
      await this.#git([
        "push",
        `--force-with-lease=${this.#ref}:${expectedSha}`,
        this.#remote,
        `${targetSha}:${this.#ref}`,
      ], this.#cwd);
    } catch (error) {
      // A refused lease is not a failure to report as one: it means another
      // controller moved the pointer, and the caller has to re-read rather
      // than retry.
      const current = await this.read().catch(() => "unreadable");
      if (current !== expectedSha) throw new DeployRefError("DEPLOY_REF_LEASE_REFUSED", `expected ${expectedSha}, found ${current}`);
      throw error;
    }

    const moved = await this.read();
    if (moved !== targetSha) throw new DeployRefError("DEPLOY_REF_NOT_MOVED", `wanted ${targetSha}, found ${moved}`);
    return moved;
  }
}
