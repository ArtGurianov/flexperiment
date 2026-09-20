/**
 * The deployment system, as much of it as a cutover needs and no more.
 *
 * Two things this deliberately does not do. It never logs the token or a URL
 * carrying one - a deploy log is read by more people than a secret store is.
 * And it never treats an accepted request as a completed deployment: the API
 * answers a POST long before anything is serving, so every deploy is followed
 * to a terminal state and checked against the commit that was asked for.
 */

export type CoolifyApplication = {
  readonly uuid: string;
  readonly name: string;
  readonly buildPack: string;
  readonly gitBranch: string;
  readonly gitCommitSha: string | null;
};

export type CoolifyDeployment = {
  readonly uuid: string;
  readonly status: string;
  readonly commit: string | null;
};

export class CoolifyError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type CoolifyClientOptions = {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long a single deployment may take before it is a timeout rather than a failure. */
  readonly deploymentTimeoutMs?: number;
  readonly pollIntervalMs?: number;
};

const TERMINAL_SUCCESS = "finished";
const TERMINAL_FAILURE = new Set(["failed", "cancelled", "error", "cancelled-by-user"]);

export class CoolifyClient {
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #pollMs: number;

  constructor(options: CoolifyClientOptions) {
    if (!options.apiUrl.trim()) throw new CoolifyError("COOLIFY_API_URL_MISSING");
    if (!options.token.trim()) throw new CoolifyError("COOLIFY_TOKEN_MISSING");
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#timeoutMs = options.deploymentTimeoutMs ?? 15 * 60_000;
    this.#pollMs = options.pollIntervalMs ?? 5_000;
  }

  async application(uuid: string): Promise<CoolifyApplication> {
    const body = await this.request("GET", `/applications/${encodeURIComponent(uuid)}`);
    return {
      uuid: String(body.uuid ?? uuid),
      name: String(body.name ?? ""),
      buildPack: String(body.build_pack ?? ""),
      gitBranch: String(body.git_branch ?? ""),
      gitCommitSha: body.git_commit_sha === null || body.git_commit_sha === undefined ? null : String(body.git_commit_sha),
    };
  }

  /**
   * Pins the exact commit and reads it back.
   *
   * The read-back is the point. A PATCH that returns 200 without storing what
   * it was given would leave the next deploy taking whatever the branch points
   * at - which is the failure this pinning exists to remove, arriving silently.
   */
  async pinCommit(uuid: string, commit: string): Promise<CoolifyApplication> {
    await this.request("PATCH", `/applications/${encodeURIComponent(uuid)}`, { git_commit_sha: commit });
    const application = await this.application(uuid);
    if (application.gitCommitSha !== commit) {
      throw new CoolifyError("COOLIFY_COMMIT_PIN_NOT_STORED", `${uuid}: asked ${commit}, stored ${application.gitCommitSha ?? "null"}`);
    }
    return application;
  }

  /** The images this installation could still roll back to. Empty means a rollback would have nothing to restore. */
  async rollbackImages(uuid: string): Promise<readonly string[]> {
    const body = await this.request("GET", `/applications/${encodeURIComponent(uuid)}/rollback-images`);
    const images = Array.isArray(body) ? body : Array.isArray(body.images) ? body.images : [];
    return (images as Record<string, unknown>[])
      .map((image) => String(image.tag ?? image.commit ?? image.name ?? ""))
      .filter(Boolean);
  }

  /** Starts a deployment and returns its uuid. Acceptance, not convergence - the caller must await it. */
  async startDeployment(uuid: string): Promise<string> {
    const body = await this.request("POST", `/deploy?uuid=${encodeURIComponent(uuid)}`);
    const queued = Array.isArray(body.deployments) ? (body.deployments as Record<string, unknown>[])[0] : undefined;
    const deploymentUuid = String(queued?.deployment_uuid ?? body.deployment_uuid ?? "");
    if (!deploymentUuid) throw new CoolifyError("COOLIFY_DEPLOYMENT_NOT_QUEUED", uuid);
    return deploymentUuid;
  }

  /**
   * Restores a retained image for one application, and returns the deployment
   * to follow. It is not a deploy of a commit: the image already exists or the
   * call has nothing to restore, which is why `rollbackImages` is checked
   * first rather than this being allowed to improvise a rebuild.
   */
  async rollback(uuid: string, commit: string): Promise<string> {
    const body = await this.request("POST", `/applications/${encodeURIComponent(uuid)}/rollback`, { commit });
    const deploymentUuid = String(body.deployment_uuid ?? body.uuid ?? "");
    if (!deploymentUuid) throw new CoolifyError("COOLIFY_ROLLBACK_NOT_QUEUED", `${uuid} -> ${commit}`);
    return deploymentUuid;
  }

  async deployment(uuid: string): Promise<CoolifyDeployment> {
    const body = await this.request("GET", `/deployments/${encodeURIComponent(uuid)}`);
    return {
      uuid: String(body.deployment_uuid ?? body.uuid ?? uuid),
      status: String(body.status ?? "unknown"),
      commit: body.commit === null || body.commit === undefined ? null : String(body.commit),
    };
  }

  /**
   * Follows one deployment to a terminal state.
   *
   * A timeout is reported as a timeout, never as a failure: a deployment still
   * running when we stopped watching may yet succeed, and recording it as
   * failed would invite a caller to act as though production had not moved.
   */
  async awaitDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    const deadline = this.#clock() + this.#timeoutMs;
    for (;;) {
      const deployment = await this.deployment(deploymentUuid);
      if (deployment.status === TERMINAL_SUCCESS || TERMINAL_FAILURE.has(deployment.status)) return deployment;
      if (this.#clock() >= deadline) throw new CoolifyError("COOLIFY_DEPLOYMENT_TIMED_OUT", `${deploymentUuid}: last status ${deployment.status}`);
      await this.#sleep(this.#pollMs);
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // The path is safe to name; the token and the full URL are not.
      throw new CoolifyError("COOLIFY_UNREACHABLE", `${method} ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const text = await response.text();
    if (!response.ok) throw new CoolifyError("COOLIFY_REQUEST_FAILED", `${method} ${path}: HTTP ${response.status}`);
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CoolifyError("COOLIFY_RESPONSE_MALFORMED", `${method} ${path}`);
    }
  }
}
