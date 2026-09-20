import { CoolifyClient, CoolifyError, type CoolifyDeployment } from "./coolify";
import { ProductionDeployRefStore } from "./deploy-ref";
import type { DeploymentDriver, RecoveryDriver } from "./orchestrator";
import type { PreDeploySnapshot, RuntimeTopology } from "./deploy-session";

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
   * Coolify's rollback depends on a retained image, and an image that has been
   * pruned is discovered either now or in the middle of a recovery. A cutover
   * that cannot be undone must not begin.
   */
  async assertRecoverable(sha: string): Promise<void> {
    for (const application of this.options.applications) {
      const images = await this.options.client.rollbackImages(application.uuid);
      if (!images.some((image) => image.includes(sha))) {
        throw new DeploymentError("DEPLOYMENT_ROLLBACK_IMAGE_MISSING", `${application.name}: no retained image for ${sha}`);
      }
    }
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

  /**
   * Puts production back on the pre-deploy vector.
   *
   * The pointer moves back first. A runtime restored to the old commits while
   * the ref still names the new one is not a production that was left alone -
   * it is one waiting to move again, and the next ordinary deploy would undo
   * the recovery without anyone asking it to.
   *
   * Then each application is rolled back to its retained image. A missing image
   * is not quietly rebuilt: a rebuild is a new artifact, and recovery is meant
   * to restore the one that was running, so this refuses and leaves the
   * session in recovery with sales shut.
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

    for (const application of this.options.applications) {
      const images = await this.options.client.rollbackImages(application.uuid);
      if (!images.some((image) => image.includes(preSha))) {
        throw new DeploymentError("RECOVERY_ROLLBACK_IMAGE_MISSING", `${application.name}: no retained image for ${preSha}`);
      }
      const deployment = await this.options.client.awaitDeployment(await this.options.client.rollback(application.uuid, preSha));
      if (!settled(deployment)) {
        throw new DeploymentError("RECOVERY_ROLLBACK_FAILED", `${application.name}: ${deployment.status}`);
      }
      this.log(`${application.name} rolled back`);
    }
  }
}

export const isDeploymentError = (error: unknown): error is DeploymentError | CoolifyError =>
  error instanceof DeploymentError || error instanceof CoolifyError;
