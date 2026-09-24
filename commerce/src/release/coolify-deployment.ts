import { CoolifyClient, CoolifyError, type CoolifyDeployment } from "./coolify";
import { ProductionDeployRefStore } from "./deploy-ref";
import type { DeploymentDriver, RecoveryDriver } from "./orchestrator";
import type { PreDeploySnapshot, RuntimeTopology } from "./deploy-session";
import type { DeploymentKind } from "./production-config";

/**
 * Deploying, and putting production back, through the control plane that
 * already exists.
 *
 * Two facts shape this. The deploy pointer is a git ref the three Coolify
 * applications track, so moving production means moving the ref and then
 * asking Coolify to take it - and putting production back means moving the ref
 * back first, or the next ordinary deploy silently returns to the release that
 * was just undone. And there are four surfaces on three applications: commerce
 * and its worker deploy together, so they must agree afterwards or half a
 * rollout is being read as a converged one.
 */

export type SurfaceApplication = {
  /** `commerce` covers two surfaces, which is why this is a list. */
  readonly surfaces: readonly (keyof RuntimeTopology)[];
  readonly uuid: string;
  readonly name: string;
  /** Stated by configuration. Coolify's answer is verified against it, never used to choose a path. */
  readonly deploymentKind: DeploymentKind;
};


export type CoolifyDeploymentOptions = {
  readonly client: CoolifyClient;
  readonly refs: ProductionDeployRefStore;
  readonly applications: readonly SurfaceApplication[];
  readonly onProgress?: (message: string) => void;
};

export class DeploymentError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const settled = (deployment: CoolifyDeployment) => deployment.status === "finished";

export class CoolifyDeploymentDriver implements DeploymentDriver {
  constructor(private readonly options: CoolifyDeploymentOptions) {}

  private log(message: string) { this.options.onProgress?.(message); }

  /**
   * Every application can still restore the commit named, before anything is
   * asked to move.
   *
   * Recovery redeploys the predecessor commit, so what has to still exist is
   * that commit - not an image someone might have pruned. A cutover that
   * cannot be undone must not begin.
   */
  async assertRecoverable(sha: string): Promise<void> {
    const binding = await this.serverBinding();
    for (const application of this.options.applications) {
      const configured = await this.options.client.application(application.uuid);
      this.assertDeploymentKind(application, configured.buildPack);
      const active = await this.options.client.activeDeploymentQueue(application.uuid);
      if (active.length) throw new DeploymentError("DEPLOYMENT_QUEUE_ACTIVE", `${application.name}: ${active.join(",")}`);
    }
    // What recovery needs is the predecessor COMMIT, not a retained artifact.
    // Proving an image still exists locally was the premise that forced this
    // system to reimplement Docker; the pointer and the build pipeline are the
    // things a redeploy actually depends on.
    await this.options.refs.assertResolvable(sha);
    void binding;
  }

  /**
   * Configuration and control plane must agree about what this application is.
   *
   * A disagreement is refused rather than resolved: taking Coolify's answer
   * would let a reconfigured application silently change which destructive
   * path runs, and taking ours would act on a shape the control plane will not
   * honour.
   */
  private assertDeploymentKind(application: SurfaceApplication, reported: string): void {
    if (reported !== application.deploymentKind) {
      throw new DeploymentError("DEPLOYMENT_KIND_MISMATCH", `${application.name}: configured ${application.deploymentKind}, Coolify reports ${reported || "nothing"}`);
    }
  }

  /**
   * Target convergence is not permission to arm. Compose cleanup can run
   * during that deploy, so prove the frozen predecessor remains on both local
   * repositories immediately before certification is allowed to continue.
   */
  async assertPredecessorRetained(sha: string): Promise<void> {
    // Re-proved immediately before arming, for the same reason as before: the
    // window between convergence and the first external effect is when a
    // recovery source can quietly stop existing. Under the redeploy contract
    // that source is the commit, so that is what is re-proved.
    await this.options.refs.assertResolvable(sha);
  }

  /**
   * A server policy is meaningful only for the server these applications
   * actually inhabit. The resource API supplies the hidden numeric Compose id
   * and proves every trusted application UUID resolves on exactly one server.
   */
  private async serverBinding(): Promise<{ readonly serverUuid: string; resourceId(uuid: string): string }> {
    const wanted = new Set(this.options.applications.map((application) => application.uuid));
    const matches: { serverUuid: string; resources: ReadonlyMap<string, string> }[] = [];
    for (const server of await this.options.client.servers()) {
      const resources = await this.options.client.serverResources(server.uuid);
      const ids = new Map(resources
        .filter((resource) => resource.type === "application")
        .map((resource) => [resource.uuid, resource.id]));
      if ([...wanted].every((uuid) => ids.has(uuid))) matches.push({ serverUuid: server.uuid, resources: ids });
    }
    if (matches.length !== 1) throw new DeploymentError("COOLIFY_APPLICATION_SERVER_BINDING_INVALID", `${matches.length} matching servers`);
    const match = matches[0]!;
    return {
      serverUuid: match.serverUuid,
      resourceId(uuid) {
        const id = match.resources.get(uuid);
        if (!id || !/^\d+$/.test(id)) throw new DeploymentError("COOLIFY_COMPOSE_RESOURCE_ID_INVALID", uuid);
        return id;
      },
    };
  }

  /** Used by the physical Compose quiescer only after the same server binding. */
  async composeResourceId(applicationUuid: string): Promise<string> {
    return (await this.serverBinding()).resourceId(applicationUuid);
  }

  /**
   * Moves the pointer, then takes it.
   *
   * The ref moves first and by lease: asking Coolify to deploy before the
   * pointer names the target would deploy whatever it named a moment ago, and
   * a lease is what stops two controllers both believing they moved it.
   */
  async deployFrom(expectedSha: string, targetSha: string): Promise<void> {
    this.log(`moving the deploy pointer ${expectedSha} -> ${targetSha}`);
    await this.options.refs.compareAndSet(expectedSha, targetSha);
    await this.deployApplications();
  }

  /**
   * Deploys what the pointer already names, without moving it.
   *
   * For resuming a forward revision whose pointer already moved: refused unless
   * the pointer is exactly the commit asked for, so it can never deploy
   * whatever happens to be there.
   */
  async redeployAt(sha: string): Promise<void> {
    const current = await this.options.refs.read();
    if (current !== sha) throw new DeploymentError("DEPLOY_REF_NOT_AT_TARGET", `${current} != ${sha}`);
    this.log(`redeploying at ${sha}`);
    await this.deployApplications();
  }

  private async deployApplications(): Promise<void> {
    const deployments: { application: SurfaceApplication; uuid: string }[] = [];
    for (const application of this.options.applications) {
      deployments.push({ application, uuid: await this.options.client.startDeployment(application.uuid) });
      this.log(`queued ${application.name}`);
    }

    // Followed to terminal states, never inferred from the queueing call.
    for (const { application, uuid } of deployments) {
      const deployment = await this.options.client.awaitDeployment(uuid);
      if (!settled(deployment)) {
        throw new DeploymentError("DEPLOYMENT_FAILED", `${application.name}: ${deployment.status}`);
      }
      this.log(`${application.name} finished`);
    }
  }

  /** The orchestrator's narrower contract: it knows the target, the store knows where it is now. */
  async deploy(targetSha: string): Promise<void> {
    await this.deployFrom(await this.options.refs.read(), targetSha);
  }
}

export class CoolifyRecoveryDriver implements RecoveryDriver {
  constructor(private readonly options: CoolifyDeploymentOptions) {}

  private log(message: string) { this.options.onProgress?.(message); }

  async restoreApplication(name: string, sha: string): Promise<void> {
    const application = this.options.applications.find((entry) => entry.name === name);
    if (!application) throw new DeploymentError("RECOVERY_APPLICATION_UNKNOWN", name);
    // One mechanism for both kinds, because recovery is now "deploy the
    // predecessor commit" rather than "resurrect the predecessor artifact".
    // The pointer has already been moved back, so this deploys that commit.
    const current = await this.options.refs.read();
    if (current !== sha) throw new DeploymentError("RECOVERY_REF_NOT_RESTORED", `${application.name}: ref is ${current}, expected ${sha}`);
    const deployment = await this.options.client.awaitDeployment(await this.options.client.startDeployment(application.uuid));
    if (!settled(deployment)) throw new DeploymentError("RECOVERY_ROLLBACK_FAILED", `${application.name}: ${deployment.status}`);
    this.log(`${application.name} redeployed at ${sha}`);
  }

  /**
   * Puts production back on the pre-deploy vector.
   *
   * The pointer moves back first. A runtime restored to the old commits while
   * the ref still names the new one is not a production that was left alone -
   * it is one waiting to move again, and the next ordinary deploy would undo
   * the recovery without anyone asking it to.
   *
   * Then each application is redeployed at that commit through Coolify. One
   * mechanism for all three: Coolify does not own the Compose application's
   * images, and reimplementing a restore for it is what this system spent two
   * production incidents learning not to do.
   */
  async restorePreDeployTopology(snapshot: PreDeploySnapshot): Promise<void> {
    const targets = new Set(this.options.applications.flatMap((application) =>
      application.surfaces.map((surface) => snapshot.runtime[surface])));
    if (targets.size !== 1) {
      // One vector, one commit: these applications all track one ref, so a
      // snapshot naming two commits is not one this control plane can restore.
      throw new DeploymentError("RECOVERY_TOPOLOGY_NOT_UNIFORM", [...targets].join(", "));
    }
    const [preSha] = targets;

    const current = await this.options.refs.read();
    this.log(`returning the deploy pointer ${current} -> ${preSha}`);
    await this.options.refs.compareAndSet(current, preSha);

    for (const application of this.options.applications) await this.restoreApplication(application.name, preSha);
  }
}

export const isDeploymentError = (error: unknown): error is DeploymentError | CoolifyError =>
  error instanceof DeploymentError || error instanceof CoolifyError;
