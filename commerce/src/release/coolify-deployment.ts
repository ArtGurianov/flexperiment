import { CoolifyClient, CoolifyError, type CoolifyDeployment } from "./coolify";
import { DockerComposeRollbackEvidence, type ComposeRollbackEvidence } from "./compose-rollback-evidence";
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

/**
 * Which runtime shape the predecessor is in when recoverability is judged.
 *
 * Before `prepare-bootstrap`, the predecessor is serving and its running
 * containers can prove their own identity. Afterwards it is deliberately
 * stopped, and requiring running containers would make a prepared launch
 * impossible to deploy - which is exactly what it did. In that phase the
 * evidence is the retained artifact, not a process.
 */
export type PredecessorRuntimePhase = "RUNNING" | "PREPARED_STOPPED";

export type CoolifyDeploymentOptions = {
  readonly client: CoolifyClient;
  readonly refs: ProductionDeployRefStore;
  readonly applications: readonly SurfaceApplication[];
  readonly composeRollbackEvidence?: ComposeRollbackEvidence;
  /** Trusted local repositories for the Compose application's services. */
  readonly composeRepositories?: readonly string[];
  /**
   * Restores the Compose application to a commit.
   *
   * Coolify does not own those images, so there is nothing here to roll back;
   * the composition root supplies the trusted control that captures the exact
   * predecessor units and starts them. Absent, a Compose restore is refused
   * rather than attempted through the wrong mechanism.
   */
  readonly composeRestore?: (sha: string) => Promise<void>;
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
  async assertRecoverable(sha: string, phase: PredecessorRuntimePhase = "RUNNING"): Promise<void> {
    const binding = await this.serverBinding();
    const cleanup = await this.options.client.serverDockerCleanup(binding.serverUuid);
    if (cleanup.applicationImageRetentionDisabled) {
      throw new DeploymentError("DEPLOYMENT_APPLICATION_IMAGE_RETENTION_DISABLED");
    }
    for (const application of this.options.applications) {
      const configured = await this.options.client.application(application.uuid);
      this.assertDeploymentKind(application, configured.buildPack);
      if (configured.dockerImagesToKeep === null || configured.dockerImagesToKeep < 2) {
        throw new DeploymentError("DEPLOYMENT_IMAGE_RETENTION_INSUFFICIENT", `${application.name}: ${configured.dockerImagesToKeep ?? "unreadable"}`);
      }
      const active = await this.options.client.activeDeploymentQueue(application.uuid);
      if (active.length) throw new DeploymentError("DEPLOYMENT_QUEUE_ACTIVE", `${application.name}: ${active.join(",")}`);
      if (application.deploymentKind === "dockercompose") {
        await this.assertComposeRecoverable(binding.resourceId(application.uuid), sha, phase);
        continue;
      }
      // A Dockerfile application's retained image is a Coolify fact and stays
      // readable whether or not anything is running, so this needs no phase.
      const images = await this.options.client.rollbackImages(application.uuid);
      if (!images.some((image) => image.includes(sha))) {
        throw new DeploymentError("DEPLOYMENT_ROLLBACK_IMAGE_MISSING", `${application.name}: no retained image for ${sha}`);
      }
    }
  }

  /**
   * Compose recoverability, judged against the phase production is actually in.
   *
   * RUNNING may read identity off the live containers, which is the stronger
   * proof and the one to use while it is available. PREPARED_STOPPED cannot:
   * preparation stopped those containers on purpose. There the claim is that
   * the predecessor artifacts are still on disk, proved from the trusted
   * repositories rather than from a process that is meant to be absent.
   */
  private async assertComposeRecoverable(resourceId: string, sha: string, phase: PredecessorRuntimePhase): Promise<void> {
    const evidence = this.options.composeRollbackEvidence ?? new DockerComposeRollbackEvidence();
    if (phase === "RUNNING") {
      await evidence.assertPreDeployRecoverable(resourceId, sha);
      return;
    }
    const repositories = this.options.composeRepositories ?? [];
    if (!repositories.length) throw new DeploymentError("DEPLOYMENT_COMPOSE_REPOSITORIES_UNCONFIGURED");
    await evidence.assertRetainedArtifacts(repositories, sha);
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
    const binding = await this.serverBinding();
    for (const application of this.options.applications) {
      const configured = await this.options.client.application(application.uuid);
      this.assertDeploymentKind(application, configured.buildPack);
      if (application.deploymentKind === "dockercompose") {
        await (this.options.composeRollbackEvidence ?? new DockerComposeRollbackEvidence()).assertPredecessorStillPresent(binding.resourceId(application.uuid), sha);
        continue;
      }
      const images = await this.options.client.rollbackImages(application.uuid);
      if (!images.some((image) => image.includes(sha))) {
        throw new DeploymentError("DEPLOYMENT_PREDECESSOR_IMAGE_MISSING", `${application.name}: no retained image for ${sha}`);
      }
    }
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
    // `assertRecoverable` has distinguished the two kinds since it was written;
    // this did not, and would have asked Coolify to roll back an application
    // whose images Coolify does not own. Refused rather than attempted: a
    // Compose restore is a different mechanism, and guessing at it during a
    // recovery is how the recovery becomes the incident.
    if (application.deploymentKind === "dockercompose") {
      if (!this.options.composeRestore) {
        throw new DeploymentError("RECOVERY_COMPOSE_ROLLBACK_UNSUPPORTED", `${application.name}: Compose services are restored from their captured units, not by a Coolify image rollback`);
      }
      await this.options.composeRestore(sha);
      this.log(`${application.name} restored from captured units`);
      return;
    }
    const images = await this.options.client.rollbackImages(application.uuid);
    if (!images.some((image) => image.includes(sha))) {
      throw new DeploymentError("RECOVERY_ROLLBACK_IMAGE_MISSING", `${application.name}: no retained image for ${sha}`);
    }
    const deployment = await this.options.client.awaitDeployment(await this.options.client.rollback(application.uuid, sha));
    if (!settled(deployment)) throw new DeploymentError("RECOVERY_ROLLBACK_FAILED", `${application.name}: ${deployment.status}`);
    this.log(`${application.name} rolled back`);
  }

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

    for (const application of this.options.applications) await this.restoreApplication(application.name, preSha);
  }
}

export const isDeploymentError = (error: unknown): error is DeploymentError | CoolifyError =>
  error instanceof DeploymentError || error instanceof CoolifyError;
