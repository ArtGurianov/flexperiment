/** Independent V2 controller. No import or call into the legacy release runner. */
const refuse = (code) => { throw new Error(code); };
const shaPattern = /^[0-9a-f]{40}$/;
export const targets = ["canary", "production"];

export async function admitRelease(sha, github) {
  if (!shaPattern.test(sha)) refuse("V2_SOURCE_SHA_INVALID");
  const main = await github("/commits/main");
  if (main.sha !== sha) refuse("V2_SOURCE_NOT_MAIN_HEAD");
  const checks = await github(`/commits/${sha}/check-runs?per_page=100`);
  for (const name of ["test", "docker-build"]) {
    const candidates = checks.check_runs.filter((check) => check.name === name && check.head_sha === sha && check.app?.slug === "github-actions")
      .sort((a, b) => b.id - a.id);
    if (candidates[0]?.status !== "completed" || candidates[0]?.conclusion !== "success") refuse("V2_EXACT_SOURCE_CI_REQUIRED");
  }
}

export function validateApp(app, env, storages, target, uuid) {
  if (!targets.includes(target) || !/^[a-z0-9]{20,32}$/.test(uuid)) refuse("V2_TARGET_INVALID");
  if (app.uuid !== uuid || app.name !== (target === "canary" ? "flexperiment-commerce-v2-canary" : "flexperiment-commerce-v2")) refuse("V2_APP_IDENTITY_MISMATCH");
  if (app.git_repository !== "ArtGurianov/flexperiment" || app.git_branch !== "main"
    || app.build_pack !== "dockerfile" || app.dockerfile_location !== "/Dockerfile.commerce-v2"
    || app.ports_exposes !== "3002" || app.fqdn || app.settings?.is_auto_deploy_enabled !== false) refuse("V2_APP_NOT_ISOLATED");
  const rows = env.filter((entry) => !entry.is_preview);
  const required = {
    NODE_ENV: "production", DEPLOY_ENV: target === "canary" ? "staging" : "production",
    COMMERCE_V2_FOUNDATION_MODE: "true", COMMERCE_V2_ENVIRONMENT: target,
    PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false", KINESCOPE_DELIVERY_MODE: "open",
    COMMERCE_V2_DATABASE_PATH: "/var/lib/flexperiment-v2/commerce.sqlite",
    COMMERCE_V2_BACKUP_PATH: "/var/lib/flexperiment-v2-backups", PORT: "3002", MERCHANT_PROMOTION_PREFIX: "FX-",
    REFREF_READINESS_URL: target === "canary" ? "https://canary-ops.refref.ru/readyz" : "https://ops.refref.ru/readyz",
  };
  for (const [key, value] of Object.entries(required)) {
    const matching = rows.filter((entry) => entry.key === key);
    if (matching.length !== 1 || matching[0].value !== value || matching[0].is_runtime !== true) refuse("V2_ENVIRONMENT_DIFFERS");
  }
  const service = rows.filter((entry) => entry.key === "PLATFORM_SERVICE_TOKEN");
  if (service.length !== 1 || service[0].present !== true || service[0].length < 32
    || service[0].is_buildtime !== false || service[0].is_runtime !== true) refuse("V2_SERVICE_TOKEN_REQUIRED");
  const recipient = rows.filter((entry) => entry.key === "COMMERCE_V2_BACKUP_AGE_RECIPIENT");
  if (recipient.length !== 1 || !/^age1[0-9a-z]{58}$/.test(recipient[0].value ?? "")) refuse("V2_BACKUP_RECIPIENT_REQUIRED");
  if (rows.some((entry) => /^(TOCHKA_|ALFA_|REFREF_API_KEY|REFUND_ENVELOPE_)/.test(entry.key) && entry.present)) refuse("V2_PROVIDER_CREDENTIAL_FORBIDDEN");
  if (storages.file_storages?.length || storages.persistent_storages?.length !== 2) refuse("V2_STORAGE_CONFIGURATION_DIFFERS");
  const volumes = storages.persistent_storages;
  for (const path of [required.COMMERCE_V2_BACKUP_PATH, "/var/lib/flexperiment-v2"]) {
    const found = volumes.filter((volume) => volume.mount_path === path);
    if (found.length !== 1 || !found[0].name?.startsWith(`${uuid}-`) || found[0].host_path) refuse("V2_VOLUME_NOT_ISOLATED");
  }
  if (volumes[0].name === volumes[1].name) refuse("V2_VOLUME_NOT_ISOLATED");
  return volumes.map((volume) => ({ name: volume.name, destination: volume.mount_path }));
}

export function verifyRuntime(result, sha, expectedMounts) {
  if (result.identity?.schema !== "flexperiment.build-identity/1" || result.identity?.service !== "commerce-v2"
    || result.identity?.sourceCommit !== sha || result.baked?.sourceCommit !== sha || result.identityMode !== "444") refuse("V2_RUNTIME_IDENTITY_DIFFERS");
  if (result.ready?.sourceCommit !== sha || result.ready?.service !== "commerce-v2" || result.ready?.ok !== true
    || result.ready.foundationMode !== true || result.ready.core?.paymentMode !== "disabled"
    || result.ready.core?.database !== "ok" || result.ready.capabilities?.refref !== "ready") refuse("V2_RUNTIME_NOT_READY");
  if (!result.containerId || !result.startedAt || !expectedMounts.every((expected) => result.mounts?.some((mount) =>
    mount.type === "volume" && mount.name === expected.name && mount.destination === expected.destination && mount.rw === true))) refuse("V2_RUNTIME_VOLUME_DIFFERS");
}

/** Both targets are inspected before writes; production depends on actual canary proof. */
export async function deployFoundation(sha, io) {
  await admitRelease(sha, io.github);
  if (io.apps.canary === io.apps.production) refuse("V2_ENVIRONMENTS_NOT_SEPARATE");
  const preflight = {};
  for (const target of targets) {
    const uuid = io.apps[target];
    const app = await io.api("GET", `/applications/${uuid}`);
    const env = await io.api("GET", `/applications/${uuid}/envs`);
    const storage = await io.api("GET", `/applications/${uuid}/storages`);
    preflight[target] = { pin: app.git_commit_sha, mounts: validateApp(app, env, storage, target, uuid) };
  }
  const proofs = {};
  for (const target of targets) {
    await admitRelease(sha, io.github);
    const uuid = io.apps[target];
    // Revalidate mutable environment/storage immediately at the consuming seam.
    const current = await io.api("GET", `/applications/${uuid}`);
    validateApp(current, await io.api("GET", `/applications/${uuid}/envs`), await io.api("GET", `/applications/${uuid}/storages`), target, uuid);
    if (current.git_commit_sha !== preflight[target].pin) refuse("V2_APP_PIN_DRIFT");
    // CAS only the dedicated V2 ref. Never production-deploy/runtime-candidate.
    await io.casRef(target, sha);
    await io.api("PATCH", `/applications/${uuid}`, { git_commit_sha: sha });
    await io.api("PATCH", `/applications/${uuid}/envs`, { key: "SOURCE_COMMIT", value: sha, is_buildtime: true, is_runtime: true, is_preview: false });
    const readBack = await io.api("GET", `/applications/${uuid}`);
    if (readBack.git_commit_sha !== sha) refuse("V2_SOURCE_PIN_NOT_SAVED");
    const sourceRows = await io.api("GET", `/applications/${uuid}/envs`);
    const source = sourceRows.filter((row) => row.key === "SOURCE_COMMIT" && !row.is_preview);
    if (source.length !== 1 || source[0].value !== sha || !source[0].is_buildtime) refuse("V2_BUILD_SHA_NOT_SAVED");
    // Existing foundation state is snapshotted before replacement. A first boot has no old DB.
    const old = await io.runtime(target, { optional: true });
    if (old) await io.storage(target, "backup");
    await io.deploy(target, sha);
    const first = await io.waitRuntime(target, sha, preflight[target].mounts);
    verifyRuntime(first, sha, preflight[target].mounts);
    const { marker } = await io.storage(target, "mark");
    if (!/^[0-9a-f-]{36}$/.test(marker ?? "")) refuse("V2_DURABILITY_MARKER_INVALID");
    const backup = await io.storage(target, "backup");
    if (!/^[0-9a-f]{64}$/.test(backup.sha256 ?? "") || !(backup.size > 0)) refuse("V2_BACKUP_PROOF_INVALID");
    const archived = await io.archiveBackup(target, backup);
    if (archived.sha256 !== backup.sha256) refuse("V2_BACKUP_TRANSFER_DIFFERS");
    await io.restart(target);
    const restarted = await io.waitRuntime(target, sha, preflight[target].mounts, first);
    verifyRuntime(restarted, sha, preflight[target].mounts);
    if (restarted.startedAt === first.startedAt) refuse("V2_RESTART_NOT_OBSERVED");
    if ((await io.storage(target, "verify", marker))?.durability !== "PASS") refuse("V2_DURABILITY_NOT_PROVEN");
    await io.deploy(target, sha);
    const redeployed = await io.waitRuntime(target, sha, preflight[target].mounts, restarted);
    verifyRuntime(redeployed, sha, preflight[target].mounts);
    if (redeployed.containerId === restarted.containerId && redeployed.startedAt === restarted.startedAt) refuse("V2_REDEPLOY_NOT_OBSERVED");
    if ((await io.storage(target, "verify", marker))?.durability !== "PASS") refuse("V2_DURABILITY_NOT_PROVEN");
    proofs[target] = { sourceCommit: sha, persistence: "PASS", backup: archived, refref: "ready", paymentMode: "disabled" };
    await io.record(target, proofs[target]);
  }
  return proofs;
}
