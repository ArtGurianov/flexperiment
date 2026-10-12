/** Independent V2 controller. No import or call into the legacy release runner. */
const refuse = (code) => { throw new Error(code); };
const shaPattern = /^[0-9a-f]{40}$/;
export const targets = ["canary", "production"];
export const normalCanaryOrigins = {
  PLATFORM_ORIGIN: "https://canary-platform.flexperiment.ru",
  LAB_ORIGIN: "https://canary-lab.flexperiment.ru",
  ADMIN_ORIGIN: "https://canary-admin.flexperiment.ru",
  API_ORIGIN: "https://canary-api.flexperiment.ru",
};

// Fixed canary-only host custody; never merchant/editorial/backup directories.
export const erasureCanaryMounts = [
  { source: "/var/lib/flexperiment-erasure-canary/installation", destination: "/etc/flexperiment-erasure", rw: false },
  { source: "/var/lib/flexperiment-erasure-canary/runtime-keys", destination: "/etc/flexperiment-erasure-keys", rw: false },
  { source: "/var/lib/flexperiment-erasure-canary/runtime-read", destination: "/etc/flexperiment-erasure-read", rw: false },
  { source: "/var/lib/flexperiment-erasure-canary/mirror", destination: "/etc/flexperiment-erasure-mirror", rw: false },
  { source: "/var/lib/flexperiment-erasure-canary/fence", destination: "/var/lib/flexperiment-erasure-canary/fence", rw: true },
];
export const erasureCanaryEnvironment = {
  ERASURE_FENCING_ENABLED: "true", ERASURE_SCOPE: "canary",
  ERASURE_FENCE_DIRECTORY: "/var/lib/flexperiment-erasure-canary/fence",
  ERASURE_VERIFICATION_KEYS_FILE: "/etc/flexperiment-erasure-keys/verification.json",
  ERASURE_LIBRARY_CONFIG_FILE: "/etc/flexperiment-erasure-read/reader.json",
};

export function validateCheckout(source, head, dirty, origin) {
  if (!shaPattern.test(source) || head !== source || dirty) refuse("V2_CONTROLLER_CHECKOUT_DIFFERS");
  if (!["git@github.com:ArtGurianov/flexperiment.git", "https://github.com/ArtGurianov/flexperiment.git",
    "https://github.com/ArtGurianov/flexperiment"].includes(origin)) refuse("V2_CONTROLLER_REMOTE_DIFFERS");
}

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

export function validateApp(app, env, storages, target, uuid, mode = "foundation") {
  if (!["foundation", "normal-canary"].includes(mode) || (mode === "normal-canary" && target !== "canary")) refuse("V2_MODE_TARGET_REFUSED");
  if (!targets.includes(target) || !/^[a-z0-9]{20,32}$/.test(uuid)) refuse("V2_TARGET_INVALID");
  if (app.uuid !== uuid || app.name !== (target === "canary" ? "flexperiment-commerce-v2-canary" : "flexperiment-commerce-v2")) refuse("V2_APP_IDENTITY_MISMATCH");
  if (app.git_repository !== "ArtGurianov/flexperiment" || app.git_branch !== "main"
    || app.build_pack !== "dockerfile" || app.dockerfile_location !== "/Dockerfile.commerce-v2"
    || app.ports_exposes !== "3002" || app.fqdn || app.settings?.is_auto_deploy_enabled !== false
    || app.portsMapped !== false || app.customRouting !== false || app.hasUnsafeOverrides !== false) refuse("V2_APP_NOT_ISOLATED");
  const rows = env.filter((entry) => !entry.is_preview);
  const required = {
    NODE_ENV: "production", DEPLOY_ENV: target === "canary" ? "staging" : "production",
    COMMERCE_V2_FOUNDATION_MODE: mode === "foundation" ? "true" : "false", COMMERCE_V2_ENVIRONMENT: target,
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
  if (mode === "normal-canary") {
    for (const [key, value] of Object.entries({ ...normalCanaryOrigins, AUTH_EMAIL_PROVIDER: "notisend",
      NOTISEND_FROM_EMAIL: "noreply@flexperiment.ru", NOTISEND_REPLY_TO: "art@flexperiment.ru" })) {
      const found = rows.filter((entry) => entry.key === key);
      if (found.length !== 1 || found[0].value !== value || found[0].is_runtime !== true
        || found[0].is_buildtime !== false) refuse("V2_NORMAL_ORIGIN_OR_MAIL_DIFFERS");
    }
    for (const key of ["BETTER_AUTH_SECRET", "AUTH_EMAIL_OUTBOX_KEY", "CAMPAIGN_UNSUBSCRIBE_SECRET",
      "COMMERCE_SESSION_SECRET", "COMMERCE_ADMIN_PASSWORD_SCRYPT", "SMARTCAPTCHA_SERVER_KEY", "NOTISEND_API_KEY", "NOTISEND_FROM_NAME"]) {
      const found = rows.filter((entry) => entry.key === key);
      if (found.length !== 1 || found[0].present !== true || found[0].length < (key === "NOTISEND_FROM_NAME" ? 1 : 32)
        || found[0].is_buildtime !== false || found[0].is_runtime !== true) refuse("V2_NORMAL_RUNTIME_INPUT_REQUIRED");
    }
    if (rows.some((entry) => /^AUTH_EMAIL_DELIVERY_(ENDPOINT|TOKEN)$/.test(entry.key) && entry.present)) refuse("V2_NORMAL_MAIL_RELAY_FORBIDDEN");
  }
  const erasureRows = rows.filter(entry => entry.key.startsWith("ERASURE_"));
  const erasure = erasureRows.length > 0;
  if (erasure) {
    if (mode !== "normal-canary" || target !== "canary" || erasureRows.length !== Object.keys(erasureCanaryEnvironment).length
      || env.some(entry => entry.is_preview && entry.key.startsWith("ERASURE_"))) refuse("V2_ERASURE_SCOPE_REFUSED");
    for (const [key, value] of Object.entries(erasureCanaryEnvironment)) {
      const found = erasureRows.filter(entry => entry.key === key);
      if (found.length !== 1 || found[0].value !== value || found[0].is_runtime !== true || found[0].is_buildtime !== false) refuse("V2_ERASURE_ENVIRONMENT_DIFFERS");
    }
  }
  if (storages.file_storages?.length || storages.persistent_storages?.length !== (erasure ? 7 : 2)) refuse("V2_STORAGE_CONFIGURATION_DIFFERS");
  const volumes = storages.persistent_storages.filter(volume => !volume.host_path);
  if (volumes.length !== 2) refuse("V2_VOLUME_NOT_ISOLATED");
  for (const path of [required.COMMERCE_V2_BACKUP_PATH, "/var/lib/flexperiment-v2"]) {
    const found = volumes.filter((volume) => volume.mount_path === path);
    if (found.length !== 1 || !found[0].name?.startsWith(`${uuid}-`) || found[0].host_path) refuse("V2_VOLUME_NOT_ISOLATED");
  }
  if (volumes[0].name === volumes[1].name) refuse("V2_VOLUME_NOT_ISOLATED");
  const mounts = volumes.map((volume) => ({ name: volume.name, destination: volume.mount_path }));
  if (erasure) for (const expected of erasureCanaryMounts) {
    const found = storages.persistent_storages.filter(volume => volume.host_path === expected.source);
    // Coolify 4.4.6 emits host_path:mount_path verbatim as a Compose mount.
    if (found.length !== 1 || found[0].mount_path !== expected.destination + (expected.rw ? ":rw" : ":ro")
      || !found[0].name?.startsWith(uuid + "-")) refuse("V2_ERASURE_MOUNT_DIFFERS");
    mounts.push({ type: "bind", ...expected });
  }
  return mounts;
}

export function verifyRuntime(result, sha, expectedMounts, mode = "foundation") {
  if (!["foundation", "normal-canary"].includes(mode)) refuse("V2_MODE_TARGET_REFUSED");
  if (result.identity?.schema !== "flexperiment.build-identity/1" || result.identity?.service !== "commerce-v2"
    || result.identity?.sourceCommit !== sha || result.baked?.sourceCommit !== sha || result.identityMode !== "444") refuse("V2_RUNTIME_IDENTITY_DIFFERS");
  if (result.ready?.sourceCommit !== sha || result.ready?.service !== "commerce-v2" || result.ready?.ok !== true
    || result.ready.foundationMode !== (mode === "foundation") || result.ready.core?.paymentMode !== "disabled"
    || result.ready.core?.database !== "ok" || result.ready.capabilities?.refref !== "ready") refuse("V2_RUNTIME_NOT_READY");
  if (!result.containerId || !result.startedAt || result.mounts?.length !== expectedMounts.length || !expectedMounts.every((expected) => result.mounts?.some((mount) =>
    mount.type === (expected.type ?? "volume") && mount.destination === expected.destination
      && (expected.type === "bind" ? mount.source === expected.source && mount.rw === expected.rw
        : mount.name === expected.name && mount.rw === true)))) refuse("V2_RUNTIME_VOLUME_DIFFERS");
  if (expectedMounts.some(mount => mount.type === "bind") && result.ready.capabilities?.erasure !== "qualified") refuse("V2_ERASURE_RUNTIME_NOT_QUALIFIED");
  if (mode === "normal-canary" && (result.ready.capabilities?.authEmail !== "configured"
    || result.ready.capabilities?.captcha !== "configured")) refuse("V2_NORMAL_CAPABILITY_MISSING");
}

/** Closed API preparation only. No public routing, customer creation, email or promotion. */
export async function deployNormalCanary(sha, io) {
  await admitRelease(sha, io.github);
  if (io.apps.canary === io.apps.production) refuse("V2_ENVIRONMENTS_NOT_SEPARATE");
  const production = await io.snapshot("production");
  if (!/^[0-9a-f]{64}$/.test(production?.sha256 ?? "")) refuse("V2_PRODUCTION_SNAPSHOT_REQUIRED");
  const uuid = io.apps.canary;
  const app = await io.api("GET", `/applications/${uuid}`);
  const mounts = validateApp(app, await io.api("GET", `/applications/${uuid}/envs`),
    await io.api("GET", `/applications/${uuid}/storages`), "canary", uuid, "normal-canary");
  const erasure = mounts.some(mount => mount.type === "bind");
  if (erasure) {
    const admission = await io.erasureAdmission("canary", sha);
    if (admission?.qualified !== true || admission.sourceCommit !== sha) refuse("V2_ERASURE_HOST_NOT_ADMITTED");
  }
  const prodUuid = io.apps.production;
  validateApp(await io.api("GET", `/applications/${prodUuid}`), await io.api("GET", `/applications/${prodUuid}/envs`),
    await io.api("GET", `/applications/${prodUuid}/storages`), "production", prodUuid);
  const backup = await io.backupRuntime("canary");
  if (!/^[0-9a-f]{64}$/.test(backup?.sha256 ?? "") || !(backup.size > 0)) refuse("V2_BACKUP_PROOF_INVALID");
  const archived = await io.archiveBackup("canary", backup);
  if (archived.sha256 !== backup.sha256) refuse("V2_BACKUP_TRANSFER_DIFFERS");
  await admitRelease(sha, io.github);
  const current = await io.api("GET", `/applications/${uuid}`);
  validateApp(current, await io.api("GET", `/applications/${uuid}/envs`),
    await io.api("GET", `/applications/${uuid}/storages`), "canary", uuid, "normal-canary");
  if (current.git_commit_sha !== app.git_commit_sha) refuse("V2_APP_PIN_DRIFT");
  if ((await io.snapshot("production")).sha256 !== production.sha256) refuse("V2_PRODUCTION_CHANGED");
  await io.casRef("canary", sha);
  await io.api("PATCH", `/applications/${uuid}`, { git_commit_sha: sha });
  await io.api("PATCH", `/applications/${uuid}/envs`, { key: "SOURCE_COMMIT", value: sha,
    is_buildtime: true, is_runtime: true, is_preview: false });
  if ((await io.api("GET", `/applications/${uuid}`)).git_commit_sha !== sha) refuse("V2_SOURCE_PIN_NOT_SAVED");
  const source = (await io.api("GET", `/applications/${uuid}/envs`)).filter(row => row.key === "SOURCE_COMMIT" && !row.is_preview);
  if (source.length !== 1 || source[0].value !== sha || source[0].is_buildtime !== true) refuse("V2_BUILD_SHA_NOT_SAVED");
  validateApp(await io.api("GET", `/applications/${uuid}`), await io.api("GET", `/applications/${uuid}/envs`),
    await io.api("GET", `/applications/${uuid}/storages`), "canary", uuid, "normal-canary");
  if ((await io.snapshot("production")).sha256 !== production.sha256) refuse("V2_PRODUCTION_CHANGED");
  if (erasure) {
    await io.stopCanary("canary");
    if ((await io.assertNoWriters("canary"))?.exclusive !== true) refuse("V2_ERASURE_WRITERS_NOT_EXCLUSIVE");
  }
  await io.deploy("canary", sha);
  verifyRuntime(await io.waitRuntime("canary", sha, mounts), sha, mounts, "normal-canary");
  if ((await io.snapshot("production")).sha256 !== production.sha256) refuse("V2_PRODUCTION_CHANGED");
  const proof = { sourceCommit: sha, mode: "normal-canary", apiReadiness: "PASS", backup: archived,
    productionUnchanged: true, paymentMode: "disabled", qualification: "API_ONLY",
    ...(erasure ? { erasure: "QUALIFIED", replacement: "EXCLUSIVE" } : {}),
    proxy: "NOT_QUALIFIED", magicLinkDelivery: "NOT_QUALIFIED", catalogueAndLegal: "OWNER_PENDING" };
  await io.record("canary", proof);
  return { canary: proof };
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
