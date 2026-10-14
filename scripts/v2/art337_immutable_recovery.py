#!/usr/bin/env python3
"""ART-337 schema-0026 continuation. No implicit retries or legacy deployment.

All live writes require a separate owner execution GO. Merely importing this
module or validating a descriptor performs no write. The v2 controller stays
unchanged; its archived evidence is verified with its original file hash.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import art337_erasure_requalification as q

TARGET = q.TARGET
PARENT = "3496ccc7d51c691cb65035c6e09b69ac44ef24a1358d2021fc49ae88652a2a0b"
PARENT_CONTROLLER = "3501e388c0d300d6cec871fd88cd65b40c77d946671e5b6b16539a66bb4c4d6f"
ORIGINAL_APP = "xzuy7pk5y6ywjr9kh6nsk5ap"
SCHEMA = q.SCHEMAS["0026"]
# Exact independently recovered post-stop online snapshots. Changed page/row
# content is an owner-scope deviation, even if table counts still look benign.
CURRENT_SNAPSHOTS = {
    "commerce": "38071e958e5ef0700724a9e01e808f369b2fc740dc38f8145e58f5dc597c45f5",
    "payload": "7168269bb0e6e3176caaca562aae1675183f87fb39afbd04ad25a7ca8ba0596b",
}
ROOT = q.ROOT
REQUIRED = {"inventory", "backup", "restore", "boot", "artifact", "isolation", "delivery"}
SERVICES = {"commerce-v2": ORIGINAL_APP, "platform-v2": q.PLATFORM_APP,
            "admin-v2": "v2w4tnlkkt8pj2fnfspyn5l5"}
Refusal = q.Refusal
refuse = q.refuse
HASH = re.compile(r"[0-9a-f]{64}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
UUID = re.compile(r"[a-z0-9]{24}\Z")


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def run(args):
    return subprocess.check_output(args, timeout=180, stderr=subprocess.DEVNULL)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        refuse("GITHUB_REDIRECT_REFUSED")


def github(path):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "flexperiment-art337-owner"}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com/repos/ArtGurianov/flexperiment/" + path, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        return json.loads(response.read(2_000_001))


def verify_release(controller):
    if not re.fullmatch(r"[0-9a-f]{40}", controller or "") or controller == TARGET:
        refuse("CONTROLLER_SOURCE_NOT_INDEPENDENT")
    if github("git/ref/heads/main").get("object", {}).get("sha") != TARGET:
        refuse("DEPLOYMENT_SOURCE_NOT_MAIN")
    for commit in (controller, TARGET):
        values = github("commits/" + commit + "/check-runs?per_page=100")
        runs = values.get("check_runs", [])
        for name in ("test", "docker-build"):
            selected = [x for x in runs if x.get("name") == name and x.get("head_sha") == commit
                        and x.get("app", {}).get("slug") == "github-actions"]
            latest = max(selected, key=lambda x: x["id"], default={})
            if latest.get("status") != "completed" or latest.get("conclusion") != "success":
                refuse("EXACT_HEAD_CI_REQUIRED")
    for name in ("art337_immutable_recovery.py", "art337_erasure_requalification.py", "scheduled-backup.py", "art337-proof-continue.mjs"):
        raw = Path(__file__).with_name(name).read_bytes()
        blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if github("contents/scripts/v2/" + name + "?ref=" + controller).get("sha") != blob:
            refuse("PINNED_CONTROLLER_FILE_DRIFT")


def fresh(value):
    timestamp = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    age = (datetime.now(timezone.utc) - timestamp).total_seconds() if timestamp.tzinfo else -1
    if not 0 <= age <= 3600:
        refuse("PROOF_STALE_OR_FUTURE")


def read(path):
    return q.private_bytes(Path(path))


def report(manifest, name):
    entry = manifest["files"][name]
    if set(entry) != {"path", "sha256"} or not HASH.fullmatch(entry["sha256"]) \
            or not Path(entry["path"]).is_absolute():
        refuse("REPORT_DESCRIPTOR_INVALID")
    raw = read(entry["path"])
    if q.digest(raw) != entry["sha256"]:
        refuse("REPORT_DIGEST_DRIFT")
    value = json.loads(raw)
    fresh(value["recordedAt"] if "recordedAt" in value else value["generated_at_utc"])
    return value


def descriptor(value):
    """Index digests are intentionally refused: qualify a single platform image."""
    keys = {"reference", "manifestDigest", "manifest", "imageId", "rootfs", "os", "architecture", "identity"}
    if set(value) != keys or not DIGEST.fullmatch(value["manifestDigest"]) \
            or not DIGEST.fullmatch(value["imageId"]):
        refuse("ARTIFACT_DESCRIPTOR_INVALID")
    repository, separator, digest = value["reference"].partition("@")
    # A port in a registry hostname is allowed, a tag on a repository is not.
    if separator != "@" or digest != value["manifestDigest"] \
            or not re.fullmatch(r"[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9/_-]*", repository):
        refuse("MUTABLE_IMAGE_REFERENCE")
    manifest = value["manifest"]
    if manifest.get("schemaVersion") != 2 or "manifests" in manifest \
            or manifest.get("mediaType") not in ("application/vnd.oci.image.manifest.v1+json",
                                                 "application/vnd.docker.distribution.manifest.v2+json"):
        refuse("SINGLE_PLATFORM_MANIFEST_REQUIRED")
    blobs = [manifest.get("config", {})] + manifest.get("layers", [])
    if not manifest.get("layers") or any(not DIGEST.fullmatch(b.get("digest", ""))
            or type(b.get("size")) is not int or b["size"] <= 0 for b in blobs):
        refuse("MANIFEST_BLOBS_INVALID")
    if value["os"] != "linux" or value["architecture"] != "amd64" \
            or not isinstance(value["rootfs"], list) or not value["rootfs"] \
            or any(not DIGEST.fullmatch(x) for x in value["rootfs"]) \
            or len(value["rootfs"]) != len(manifest["layers"]) \
            or value["identity"] not in [
                {"schema": "flexperiment.build-identity/1", "service": service, "sourceCommit": TARGET}
                for service in SERVICES]:
        refuse("ARTIFACT_PLATFORM_OR_IDENTITY_INVALID")
    return value


def coolify_image_fields(reference):
    """Canonical persisted fields for Coolify 4.4.6 Docker Image deployments.

    Its deployment job recognizes sha256-<hex>. A bare hexadecimal tag also
    triggers API name normalization to repo@sha256; never assume repo remains
    unchanged. Use the unambiguous pair and require exactly that read-back.
    """
    if not re.fullmatch(r"[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9/_-]*@sha256:[0-9a-f]{64}", reference):
        refuse("IMMUTABLE_REFERENCE_REQUIRED")
    repository, digest = reference.split("@")
    return {"docker_registry_image_name": repository,
            "docker_registry_image_tag": "sha256-" + digest[len("sha256:"):]}


def inspect_artifact(reference, service, pull=True):
    if service not in SERVICES or not re.fullmatch(r"[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9/_-]*@sha256:[0-9a-f]{64}", reference):
        refuse("IMMUTABLE_REFERENCE_REQUIRED")
    raw = run(["docker", "buildx", "imagetools", "inspect", reference, "--raw"])
    # Hash the exact registry bytes, not a JSON reserialization.
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if digest != reference.rsplit("@", 1)[1]:
        refuse("REGISTRY_MANIFEST_DIGEST_DRIFT")
    if pull:
        run(["docker", "pull", "--platform", "linux/amd64", reference])
    values = json.loads(run(["docker", "image", "inspect", reference]))
    if len(values) != 1:
        refuse("DOCKER_IMAGE_AMBIGUOUS")
    image = values[0]
    identity = json.loads(run(["docker", "run", "--rm", "--network", "none", "--read-only",
                              "--platform", "linux/amd64", "--entrypoint", "cat", image["Id"],
                              "/app/.identity/identity.json"]))
    value = descriptor({"reference": reference, "manifestDigest": digest,
                        "manifest": json.loads(raw), "imageId": image["Id"],
                        "rootfs": image.get("RootFS", {}).get("Layers"), "os": image.get("Os"),
                        "architecture": image.get("Architecture"), "identity": identity})
    if identity["service"] != service:
        refuse("ARTIFACT_SERVICE_DRIFT")
    return value


def verify_artifact(expected, pull=True):
    descriptor(expected)
    if inspect_artifact(expected["reference"], expected["identity"]["service"], pull) != expected:
        refuse("ARTIFACT_CONTENT_DRIFT")


def verify_runtime(expected, container_id):
    """Independent container read-back, never accept SOURCE_COMMIT by itself."""
    descriptor(expected)
    values = json.loads(run(["docker", "inspect", container_id]))
    if len(values) != 1:
        refuse("INSTALLED_CONTAINER_AMBIGUOUS")
    container = values[0]
    if container["Image"] != expected["imageId"] or container["Config"]["Image"] != expected["reference"]:
        refuse("INSTALLED_ARTIFACT_MISMATCH")
    image = json.loads(run(["docker", "image", "inspect", container["Image"]]))[0]
    if image.get("RootFS", {}).get("Layers") != expected["rootfs"] \
            or (image.get("Os"), image.get("Architecture")) != (expected["os"], expected["architecture"]):
        refuse("INSTALLED_ROOTFS_OR_PLATFORM_MISMATCH")
    identity = json.loads(run(["docker", "exec", container_id, "cat", "/app/.identity/identity.json"]))
    if identity != expected["identity"]:
        refuse("INSTALLED_BAKED_IDENTITY_MISMATCH")
    return {"containerId": container["Id"], "imageId": image["Id"],
            "reference": expected["reference"], "rootfs": expected["rootfs"], "identity": identity}


def candidate(manifest):
    return canonical({"version": 3, "scope": "canary", "sourceCommit": TARGET, "recovery": "PASS",
        "previousJournalSha256": PARENT, "installationId": q.INSTALLATION,
        "readerBindingSha256": q.READER_BINDING, "schemaFingerprint": SCHEMA,
        "previousApplicationUuid": ORIGINAL_APP, "applicationUuid": manifest["applicationUuid"],
        "artifact": report(manifest, "artifact")["artifact"],
        "ledgerSequence": manifest["ledgerSequence"], "mirrorSha256": manifest["mirrorSha256"],
        "controllerCommit": manifest["controllerCommit"],
        "controllerFileSha256": q.digest(Path(__file__).read_bytes()),
        "manifestSha256": q.digest(canonical(manifest)),
        "evidence": {kind: entry["sha256"] for kind, entry in manifest["files"].items()}})


def validate(manifest):
    if manifest.get("version") != 3 or manifest.get("scope") != "canary" \
            or manifest.get("sourceCommit") != TARGET or manifest.get("parentJournalSha256") != PARENT \
            or manifest.get("schemaFingerprint") != SCHEMA \
            or manifest.get("installationId") != q.INSTALLATION \
            or manifest.get("readerBindingSha256") != q.READER_BINDING \
            or not UUID.fullmatch(manifest.get("applicationUuid", "")) \
            or manifest["applicationUuid"] in SERVICES.values() \
            or not re.fullmatch(r"[0-9a-f]{40}", manifest.get("controllerCommit", "")) \
            or manifest["controllerCommit"] == TARGET \
            or type(manifest.get("ledgerSequence")) is not int or manifest["ledgerSequence"] < 1 \
            or not HASH.fullmatch(manifest.get("mirrorSha256", "")) \
            or set(manifest.get("files", {})) != REQUIRED:
        refuse("CONTINUATION_MANIFEST_INVALID")
    reports = {kind: report(manifest, kind) for kind in REQUIRED}
    artifact = descriptor(reports["artifact"]["artifact"])
    if artifact["identity"]["service"] != "commerce-v2":
        refuse("COMMERCE_ARTIFACT_REQUIRED")
    inventory = reports["inventory"]
    if inventory.get("environment") != "canary-v2" or inventory.get("issue") != "ART-329":
        refuse("INVENTORY_SCOPE_INVALID")
    baselines = copy.deepcopy(q.APPROVED_NONZERO)
    baselines["commerce"]["schema_migrations"] = 26
    for kind, baseline in baselines.items():
        tables = inventory["inventories"][kind]["tables"]
        if len({x["table"] for x in tables}) != len(tables) \
                or {x["table"]: x["count"] for x in tables if x["count"]} != baseline \
                or inventory["snapshots"][kind]["integrity_check"] != "ok" \
                or inventory["snapshots"][kind]["snapshot_sha256"] != CURRENT_SNAPSHOTS[kind]:
            refuse("POST_MIGRATION_INVENTORY_DRIFT")
    backup = reports["backup"]
    if backup.get("state") != "READBACK_PASS" or backup.get("scope") != "canary" \
            or backup.get("sourceCommit") != TARGET or backup.get("previousChainReadback") != "PASS" \
            or backup.get("recoveryKeys") != "AVAILABLE" or set(backup.get("archives", {})) != {"commerce", "payload"}:
        refuse("CONTINUATION_BACKUP_INVALID")
    objects = backup.get("previousChainObjects", [])
    if not objects or len({x["object"] for x in objects}) != len(objects) or any(
            not HASH.fullmatch(x.get("sha256", "")) or x["sha256"] != x.get("remoteSha256")
            or type(x.get("size")) is not int or x["size"] <= 0 for x in objects):
        refuse("PREVIOUS_CHAIN_NOT_VERIFIED")
    for kind in ("commerce", "payload"):
        archive = backup["archives"][kind]
        if archive["snapshotSha256"] != inventory["snapshots"][kind]["snapshot_sha256"] \
                or archive["sha256"] != archive["remoteSha256"] \
                or archive.get("independentPlaintextSha256") != archive["snapshotSha256"] \
                or q.digest(read(archive["path"])) != archive["sha256"] \
                or len(read(archive["path"])) != archive["size"]:
            refuse("BACKUP_SNAPSHOT_OR_CIPHERTEXT_DRIFT")
    for kind, result in (("restore", "PASS"), ("boot", "BOOT_PASS")):
        proof = reports[kind]
        if proof.get("result") != result or proof.get("sourceCommit") != TARGET \
                or proof.get("proofScriptSha256") != q.digest(Path(__file__).with_name("art337-proof-continue.mjs").read_bytes()) \
                or proof.get("artifactSha256") != q.digest(canonical(artifact)) \
                or proof.get("inputCommerceSha256") != inventory["snapshots"]["commerce"]["snapshot_sha256"] \
                or proof.get("schemaFingerprint") != SCHEMA or proof.get("beforeMigrations") != 26 \
                or proof.get("afterMigrations") != 26 or proof.get("integrity") != "ok" \
                or proof.get("foreignKeys") != "ok" or proof.get("ledgerSequence") != manifest["ledgerSequence"] \
                or proof.get("mirrorSha256") != manifest["mirrorSha256"]:
            refuse("SCHEMA26_RECOVERY_PROOF_INVALID")
    if reports["restore"].get("syntheticErasedAccounts") != 1 \
            or reports["restore"].get("currentUsers") != 0 \
            or reports["boot"].get("fence") != "OPEN" or reports["boot"].get("leases") != 0:
        refuse("ERASURE_RESTORE_OR_BOOT_FAILED")
    if reports["isolation"].get("payloadWriters") != "STOPPED" \
            or reports["isolation"].get("commerceWriters") != "STOPPED" \
            or reports["isolation"].get("queuedDeployments") != 0:
        refuse("WRITER_ISOLATION_INVALID")
    delivery = reports["delivery"]
    if delivery.get("applicationUuid") != manifest["applicationUuid"] \
            or delivery.get("sourceApplicationUuid") != ORIGINAL_APP \
            or delivery.get("buildPack") != "dockerimage" \
            or delivery.get("reference") != artifact["reference"] \
            or delivery.get("mountsVerified") != "PASS" or delivery.get("namespaceVerified") != "PASS" \
            or delivery.get("backupBindingVerified") != "PASS":
        refuse("DELIVERY_BINDING_INVALID")
    return reports


def original_rpc():
    """Load the exact archived v2 validator; never rewrite its SELF_SHA256."""
    path = ROOT / "controllers" / TARGET / "owner-rpc.py"
    if q.digest(read(path)) != PARENT_CONTROLLER:
        refuse("PARENT_CONTROLLER_DRIFT")
    spec = importlib.util.spec_from_file_location("original_art337_owner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_parent(rpc):
    raw = read(ROOT / "erasure-admission.json")
    if q.digest(raw) != PARENT:
        refuse("PARENT_JOURNAL_DRIFT_OR_REPLAY")
    journal = json.loads(raw)
    rpc.verify_requalified_admission(journal)
    if journal.get("version") != 2 or journal.get("sourceCommit") != TARGET:
        refuse("PARENT_JOURNAL_INVALID")
    return raw


def installation_custody(rpc, uuid):
    """Preserve the installed owner's ACL/required-marker contract for v3 too."""
    rpc.erasure_environment(uuid)
    directory = q.ERASURE_ROOT / "installation"
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o555:
        refuse("INSTALLATION_DIRECTORY_CUSTODY_DRIFT")
    policy, _ = q.json_file(directory / "installation.json", mode=0o444)
    if policy.get("version") != 1 or policy.get("scope") != "canary" or policy.get("state") != "REQUIRED" \
            or policy.get("installationId") != q.INSTALLATION or policy.get("readerBindingSha256") != q.READER_BINDING \
            or policy.get("fenceDirectory") != str(q.ERASURE_ROOT / "fence"):
        refuse("INSTALLATION_BINDING_DRIFT")
    for subdirectory, filename in (("runtime-keys", "verification.json"), ("runtime-read", "reader.json"), ("mirror", "bundle.json")):
        parent = q.ERASURE_ROOT / subdirectory
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
            refuse("READER_DIRECTORY_CUSTODY_DRIFT")
        q.private_bytes(parent / filename, uid=1000)


def verify_preserved_chain(manifest, parent):
    parent_backup_sha = json.loads(parent)["evidence"]["backup"]
    old = json.loads(read(history_directory() / (parent_backup_sha + "-backup.json")))
    current = report(manifest, "backup")["previousChainObjects"]
    actual = {(x["object"], x["sha256"], x["size"]) for x in current}
    expected = {(x["object"], x["sha256"], x["size"]) for x in old["previousChainObjects"]}
    expected |= {("cloud:art-backups/flexperiment/art-337/canary/20261013T174700Z-post-stop/commerce.sqlite.age",
                  "a0394a25a69f8c17ece40c3eebcec1fedf4a6e77280dfcd0fadafd479ffaf2ae", 733560),
                 ("cloud:art-backups/flexperiment/art-337/canary/20261013T174700Z-post-stop/payload.sqlite.age",
                  "0224d892b6a350381889399190682111d1cde73b2b657f11aa52d64957a72541", 676200)}
    if not expected <= actual:
        refuse("PREDECESSOR_OR_SCHEMA26_BACKUP_CHAIN_MISSING")


def verify_schema26(manifest, rpc):
    path, _ = q.commerce_database_path(manifest, rpc)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)
    try:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
        sha = q.digest(json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode())
        if sha != SCHEMA or db.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] != 26:
            refuse("LIVE_SCHEMA26_REQUIRED")
    finally:
        db.close()


def no_queued_deployments(rpc, uuids):
    values = rpc.api("GET", "/deployments")
    rows = values.get("deployments") if isinstance(values, dict) else values
    if not isinstance(rows, list):
        refuse("DEPLOYMENT_CENSUS_UNKNOWN")
    # This endpoint returns currently running deployments. Reject all unrelated
    # work too: no global build/cleanup may race an admission inspection.
    if rows:
        refuse("DEPLOYMENT_IN_FLIGHT")


def verify_live(manifest, rpc, locked=False):
    reports = validate(manifest)
    no_queued_deployments(rpc, (ORIGINAL_APP, q.PLATFORM_APP, manifest["applicationUuid"]))
    parent = verify_parent(rpc)
    verify_preserved_chain(manifest, parent)
    if rpc.private_json(str(ROOT / "deploy-config.json"))["apps"]["canary"] != ORIGINAL_APP:
        refuse("ORIGINAL_OWNER_BINDING_DRIFT")
    installation_custody(rpc, ORIGINAL_APP)
    if rpc.container(ORIGINAL_APP, True) or (not locked and rpc.exclusive_canary(ORIGINAL_APP) != {"exclusive": True}):
        refuse("ORIGINAL_COMMERCE_WRITER_ACTIVE")
    q.verify_payload_stopped(rpc)
    q.verify_live_payload_snapshot(manifest, rpc)
    q.verify_live_commerce_snapshot(manifest, rpc, locked=locked)
    verify_schema26(manifest, rpc)
    app = rpc.api("GET", "/applications/" + ORIGINAL_APP)
    if app.get("git_commit_sha") != TARGET or app.get("build_pack") != "dockerfile" \
            or app.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or not str(app.get("status", "")).startswith(("exited", "stopped")):
        refuse("ORIGINAL_SOURCE_OR_STATUS_DRIFT")
    validate_delivery(manifest, rpc, reports["delivery"])
    policy, _ = q.json_file(q.ERASURE_ROOT / "installation" / "installation.json", mode=0o444)
    if policy.get("installationId") != q.INSTALLATION or policy.get("readerBindingSha256") != q.READER_BINDING \
            or policy.get("scope") != "canary" or policy.get("state") != "REQUIRED":
        refuse("INSTALLATION_BINDING_DRIFT")
    remote = json.loads(q.command(["/usr/local/bin/flexperiment-erasure", "read"]))
    mirror, sha = q.json_file(q.ERASURE_ROOT / "mirror" / "bundle.json", uid=1000)
    entries = mirror.get("entries", [])
    state, leases, unknown = q.current_fence(q.ERASURE_ROOT / "fence" / "erasure-fence.sqlite")
    if remote.get("state") != "REMOTE_VERIFIED" or remote.get("scope") != "canary" \
            or remote.get("sequence") != manifest["ledgerSequence"] \
            or sha != manifest["mirrorSha256"] or mirror.get("scope") != "canary" \
            or len(entries) != manifest["ledgerSequence"] \
            or state != ("canary", "OPEN", len(entries), entries[-1]["hash"], None) or leases or unknown:
        refuse("CURRENT_LEDGER_OR_FENCE_DRIFT")
    verify_artifact(reports["artifact"]["artifact"], pull=False)
    return parent


def validate_delivery(manifest, rpc, expected, running=False):
    uuid = manifest["applicationUuid"]
    if uuid != configured_uuid():
        refuse("DELIVERY_UUID_NOT_CREATED_BY_THIS_OPERATION")
    app = rpc.api("GET", "/applications/" + uuid)
    fields = coolify_image_fields(report(manifest, "artifact")["artifact"]["reference"])
    if app.get("uuid") != uuid or app.get("name") != "flexperiment-commerce-v2-canary-immutable" \
            or app.get("build_pack") != "dockerimage" or app.get("docker_registry_image_name") != fields["docker_registry_image_name"] \
            or app.get("docker_registry_image_tag") != fields["docker_registry_image_tag"] \
            or app.get("ports_exposes") != "3002" or app.get("fqdn") or app.get("ports_mappings") \
            or app.get("custom_network_aliases") != ORIGINAL_APP \
            or app.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or app.get("settings", {}).get("is_preview_deployments_enabled") is not False \
            or any(app.get(key) for key in ("custom_labels", "custom_docker_run_options", "pre_deployment_command", "post_deployment_command",
                                           "start_command", "install_command", "build_command", "dockerfile", "docker_compose_raw")):
        refuse("IMMUTABLE_RESOURCE_DRIFT")
    if not running and (rpc.container(uuid, True) or not str(app.get("status", "")).startswith(("exited", "stopped"))):
        refuse("DELIVERY_WRITER_ALREADY_ACTIVE")
    env = rpc.api("GET", "/applications/" + uuid + "/envs")
    storages = rpc.api("GET", "/applications/" + uuid + "/storages")
    # Private entire records bind secret presence/values without publishing them.
    for key, value in (("environmentSha256", env), ("storageSha256", storages)):
        if q.digest(canonical(value)) != expected[key]:
            refuse("DELIVERY_PRIVATE_CONFIGURATION_DRIFT")
    source = rpc.api("GET", "/applications/" + ORIGINAL_APP + "/envs")
    main = {row["key"]: row for row in source if not row.get("is_preview") and row.get("is_runtime")}
    actual = {row["key"]: row for row in env if not row.get("is_preview") and row.get("is_runtime")}
    if len(actual) != len(env) or set(actual) != set(main) or any(
            rpc.env_value(actual[key]) != rpc.env_value(main[key]) or actual[key].get("is_buildtime")
            for key in main):
        refuse("DELIVERY_RUNTIME_ENVIRONMENT_DRIFT")
    rpc.erasure_environment(uuid)
    if len(storages.get("persistent_storages", [])) or len(storages.get("file_storages", [])) != 7:
        refuse("DELIVERY_BIND_COUNT_DRIFT")
    original = rpc.api("GET", "/applications/" + ORIGINAL_APP + "/storages")
    expected_mounts = []
    for row in original["persistent_storages"]:
        if row.get("host_path"):
            refuse("ORIGINAL_VOLUME_NOT_NATIVE")
        values = json.loads(q.command(["docker", "volume", "inspect", row["name"]]))
        if len(values) != 1 or values[0]["Name"] != row["name"]:
            refuse("VOLUME_CUSTODY_DRIFT")
        path = Path(values[0]["Mountpoint"])
        identity = expected["volumeIdentity"][row["name"]]
        info = path.stat()
        if path.is_symlink() or (str(path), info.st_dev, info.st_ino) != (
                identity["path"], identity["device"], identity["inode"]):
            refuse("ORIGINAL_VOLUME_DIRECTORY_DRIFT")
        expected_mounts.append((str(path), row["mount_path"] + ":rw"))
    for row in original["file_storages"]:
        expected_mounts.append((row["fs_path"], row["mount_path"]))
    actual_mounts = []
    for row in storages["file_storages"]:
        if row.get("is_directory") is not True or row.get("is_host_file") or row.get("content"):
            refuse("DELIVERY_BIND_INVALID")
        actual_mounts.append((row["fs_path"], row["mount_path"]))
    if sorted(actual_mounts) != sorted(expected_mounts):
        refuse("DELIVERY_MOUNTS_DRIFT")


def history_directory():
    path = ROOT / "erasure-admission-history"
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        refuse("HISTORY_PERMISSIONS")
    return path


def publish(manifest, rpc):
    """A new v3 record; partial evidence prevents replay even before rename."""
    validate(manifest)
    verify_release(manifest["controllerCommit"])
    history = history_directory()
    receipt = ROOT / "art337-immutable-publication.intent.json"
    pending = ROOT / "erasure-admission.json.immutable-pending"
    if os.path.lexists(receipt) or os.path.lexists(pending) or os.path.lexists(history / (PARENT + ".json")):
        refuse("PUBLICATION_REPLAY_OR_UNKNOWN")
    with q.merchant_write_barrier(manifest, rpc):
        old = verify_live(manifest, rpc, locked=True)
        new = candidate(manifest)
        q.atomic_create(receipt, canonical({"parentSha256": PARENT, "candidateSha256": q.digest(new),
                                          "manifestSha256": q.digest(canonical(manifest))}))
        q.atomic_create(history / (PARENT + ".json"), old)
        for kind, entry in manifest["files"].items():
            raw = read(entry["path"])
            if q.digest(raw) != entry["sha256"]:
                refuse("EVIDENCE_CHANGED_DURING_PUBLICATION")
            # Content-addressed shared archive may already exist; never overwrite.
            path = history / (entry["sha256"] + "-" + kind + ".json")
            if path.exists():
                if read(path) != raw:
                    refuse("ARCHIVE_COLLISION")
            else:
                q.atomic_create(path, raw)
        q.atomic_create(pending, new)
        verify_release(manifest["controllerCommit"])
        if verify_live(manifest, rpc, locked=True) != old:
            refuse("FINAL_STATE_DRIFT")
        os.replace(pending, ROOT / "erasure-admission.json")
        q.sync_directory(ROOT)
        verify_v3(manifest, rpc)
        q.atomic_create(ROOT / "art337-immutable-publication.outcome.json",
                        canonical({"state": "PUBLISHED", "journalSha256": q.digest(new)}))
        return q.digest(new)


def verify_v3(manifest, rpc):
    new = candidate(manifest)
    if read(ROOT / "erasure-admission.json") != new \
            or q.digest(read(history_directory() / (PARENT + ".json"))) != PARENT \
            or (ROOT / "erasure-admission.json.immutable-pending").exists():
        refuse("V3_JOURNAL_READBACK_REFUSED")
    parent = json.loads(read(history_directory() / (PARENT + ".json")))
    rpc.verify_requalified_admission(parent)
    for kind, entry in manifest["files"].items():
        if q.digest(read(history_directory() / (entry["sha256"] + "-" + kind + ".json"))) != entry["sha256"]:
            refuse("V3_EVIDENCE_ARCHIVE_DRIFT")
    return q.digest(new)


def once(name, request, action):
    """Write intent BEFORE any external call; errors/uncertain responses retain it."""
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,48}", name):
        refuse("OPERATION_NAME_INVALID")
    directory = ROOT / "immutable-operations"
    if not directory.exists():
        directory.mkdir(mode=0o700)
        q.sync_directory(ROOT)
    info = directory.lstat()
    if directory.is_symlink() or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        refuse("OPERATION_DIRECTORY_INVALID")
    intent = directory / (name + ".intent.json")
    outcome = directory / (name + ".outcome.json")
    if os.path.lexists(intent) or os.path.lexists(outcome):
        refuse("OPERATION_REPLAY_OR_UNKNOWN")
    q.atomic_create(intent, canonical(request))
    result = action()
    q.atomic_create(outcome, canonical(result))
    return result


def reconcile(name):
    """Always HOLD; this operation does not call a mutating API or admit a retry."""
    directory = ROOT / "immutable-operations"
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,48}", name):
        refuse("OPERATION_NAME_INVALID")
    result = {"state": "HOLD", "reason": "READ_ONLY_RECONCILIATION_REQUIRES_REVIEW"}
    for suffix in ("intent", "outcome"):
        path = directory / (name + "." + suffix + ".json")
        result[suffix + "Sha256"] = q.digest(read(path)) if path.exists() else None
    return result


def inspect_publication():
    """Expiry-independent read-only reconciliation; never a new admission."""
    active = q.digest(read(ROOT / "erasure-admission.json"))
    intent_path = ROOT / "art337-immutable-publication.intent.json"
    pending_path = ROOT / "erasure-admission.json.immutable-pending"
    outcome_path = ROOT / "art337-immutable-publication.outcome.json"
    intent = json.loads(read(intent_path)) if intent_path.exists() else None
    candidate_sha = intent.get("candidateSha256") if intent else None
    if active not in (PARENT, candidate_sha):
        refuse("PUBLICATION_ACTIVE_JOURNAL_UNKNOWN")
    pending_sha = q.digest(read(pending_path)) if os.path.lexists(pending_path) else None
    if pending_sha is not None and pending_sha != candidate_sha:
        refuse("PUBLICATION_PENDING_UNKNOWN")
    if intent and q.digest(read(history_directory() / (PARENT + ".json"))) != PARENT:
        refuse("PUBLICATION_PARENT_ARCHIVE_DRIFT")
    return {"state": "HOLD", "reason": "PUBLICATION_RECONCILIATION_REQUIRES_REVIEW",
            "activeSha256": active, "parentSha256": PARENT, "candidateSha256": candidate_sha,
            "pendingSha256": pending_sha, "outcomeSha256": q.digest(read(outcome_path)) if outcome_path.exists() else None}


def create_delivery(artifact, rpc):
    """Supported Coolify Docker Image creation; no deploy, no env, no storage."""
    descriptor(artifact)
    if artifact["identity"]["service"] != "commerce-v2":
        refuse("COMMERCE_ARTIFACT_REQUIRED")
    verify_parent(rpc)
    if rpc.exclusive_canary(ORIGINAL_APP) != {"exclusive": True}:
        refuse("ORIGINAL_WRITER_ACTIVE")
    q.verify_payload_stopped(rpc)
    verify_artifact(artifact)
    app = rpc.api("GET", "/applications/" + ORIGINAL_APP)
    environment, destination = app["environment"], app["destination"]
    if environment["name"] != "canary-v2" or environment["project"]["uuid"] != "wclu2wovf4ctpbgam3h7grzb" \
            or destination["uuid"] != "5gwzwaau6dfwx3xrqgahstzi" \
            or destination["server"]["uuid"] != "1460ru9bxuxzrqnswauxqxhc":
        refuse("CANARY_CREATE_TOPOLOGY_DRIFT")
    fields = coolify_image_fields(artifact["reference"])
    body = {"project_uuid": environment["project"]["uuid"], "server_uuid": destination["server"]["uuid"],
            "environment_uuid": environment["uuid"], "destination_uuid": destination["uuid"],
            "name": "flexperiment-commerce-v2-canary-immutable", **fields, "ports_exposes": "3002",
            "domains": "", "autogenerate_domain": False, "instant_deploy": False,
            "is_auto_deploy_enabled": False, "is_preview_deployments_enabled": False,
            "custom_network_aliases": ORIGINAL_APP}
    result = once("commerce-resource-create", {"bodySha256": q.digest(canonical(body)),
                  "sourceUuid": ORIGINAL_APP, "reference": artifact["reference"]},
                  lambda: rpc.api("POST", "/applications/dockerimage", body))
    if not UUID.fullmatch(result.get("uuid", "")) or result["uuid"] in SERVICES.values():
        refuse("CREATION_RESPONSE_UNKNOWN")
    # Identity validation after create, before any credentials or data bindings.
    created = rpc.api("GET", "/applications/" + result["uuid"])
    if created["environment_id"] != app["environment_id"] or created["destination_id"] != app["destination_id"] \
            or any(created.get(key) != value for key, value in fields.items()) \
            or created.get("uuid") != result["uuid"] or created.get("name") != "flexperiment-commerce-v2-canary-immutable" \
            or created.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or created.get("settings", {}).get("is_preview_deployments_enabled") is not False \
            or created.get("fqdn") or created.get("ports_mappings") or created.get("build_pack") != "dockerimage" \
            or rpc.container(result["uuid"], True):
        refuse("CREATED_RESOURCE_TOPOLOGY_DRIFT")
    return {"uuid": result["uuid"], "state": "CREATED_STOPPED_NOT_ADMITTED"}


def configured_uuid():
    result = json.loads(read(ROOT / "immutable-operations" / "commerce-resource-create.outcome.json"))
    uuid = result.get("uuid", "")
    if not UUID.fullmatch(uuid) or uuid in SERVICES.values():
        refuse("CREATED_UUID_INVALID")
    return uuid


def configure_delivery(rpc):
    """Each privileged write is an independent one-shot operation, never retried."""
    verify_parent(rpc)
    if rpc.exclusive_canary(ORIGINAL_APP) != {"exclusive": True}:
        refuse("ORIGINAL_WRITER_ACTIVE")
    q.verify_payload_stopped(rpc)
    uuid = configured_uuid()
    old = rpc.api("GET", "/applications/" + ORIGINAL_APP)
    new = rpc.api("GET", "/applications/" + uuid)
    intent = json.loads(read(ROOT / "immutable-operations" / "commerce-resource-create.intent.json"))
    fields = coolify_image_fields(intent["reference"])
    if new.get("docker_registry_image_name") != fields["docker_registry_image_name"] or new.get("docker_registry_image_tag") != fields["docker_registry_image_tag"] \
            or new.get("custom_network_aliases") != ORIGINAL_APP \
            or new.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or new.get("settings", {}).get("is_preview_deployments_enabled") is not False:
        refuse("CONFIGURATION_ARTIFACT_OR_AUTODEPLOY_DRIFT")
    if not str(new.get("status", "")).startswith(("exited", "stopped")) \
            or new.get("environment_id") != old["environment_id"] or new.get("destination_id") != old["destination_id"] \
            or new.get("build_pack") != "dockerimage" or rpc.container(uuid, True) \
            or new.get("fqdn") or new.get("ports_mappings") \
            or new.get("name") != "flexperiment-commerce-v2-canary-immutable":
        refuse("CONFIGURATION_TARGET_DRIFT")
    rows = rpc.api("GET", "/applications/" + ORIGINAL_APP + "/envs")
    primary = [row for row in rows if not row.get("is_preview") and row.get("is_runtime")]
    if len({row["key"] for row in primary}) != len(primary):
        refuse("ORIGINAL_ENVIRONMENT_AMBIGUOUS")
    values = {row["key"]: rpc.env_value(row) for row in primary}
    required = {"SOURCE_COMMIT": TARGET, "PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false",
                "COMMERCE_V2_FOUNDATION_MODE": "false", **rpc.ERASURE_ENV}
    if any(values.get(key) != value for key, value in required.items()) \
            or any(re.match(r"TOCHKA_|ALFA_|REFREF_API_KEY|REFUND_ENVELOPE_", key) and value for key, value in values.items()):
        refuse("ORIGINAL_RUNTIME_INPUT_DRIFT")
    for row in primary:
        body = {"key": row["key"], "value": rpc.env_value(row), "is_preview": False,
                "is_runtime": True, "is_buildtime": False, "is_literal": True}
        # Neither secrets nor a raw API response containing them enter evidence.
        def save_environment(body=body):
            rpc.api("POST", "/applications/" + uuid + "/envs", body)
            return {"saved": True}
        once("env-" + q.digest(row["key"].encode())[:32],
             {"uuid": uuid, "key": row["key"], "bodySha256": q.digest(canonical(body))}, save_environment)
    original = rpc.api("GET", "/applications/" + ORIGINAL_APP + "/storages")
    mounts = []
    identities = {}
    for row in original["persistent_storages"]:
        if row.get("host_path"):
            refuse("ORIGINAL_VOLUME_NOT_NATIVE")
        image = json.loads(q.command(["docker", "volume", "inspect", row["name"]]))
        if len(image) != 1 or image[0]["Name"] != row["name"]:
            refuse("ORIGINAL_VOLUME_IDENTITY_DRIFT")
        path = Path(image[0]["Mountpoint"])
        info = path.stat()
        if path.is_symlink() or not path.is_dir():
            refuse("ORIGINAL_VOLUME_DIRECTORY_INVALID")
        identities[row["name"]] = {"path": str(path), "device": info.st_dev, "inode": info.st_ino}
        mounts.append({"fs_path": str(path), "mount_path": row["mount_path"] + ":rw"})
    mounts += [{"fs_path": row["fs_path"], "mount_path": row["mount_path"]} for row in original["file_storages"]]
    if len(mounts) != 7:
        refuse("ORIGINAL_STORAGE_COUNT_DRIFT")
    for row in mounts:
        body = {"type": "file", "is_directory": True, "is_host_file": False, **row}
        def save_storage(body=body):
            rpc.api("POST", "/applications/" + uuid + "/storages", body)
            return {"saved": True}
        once("mount-" + q.digest(row["mount_path"].encode())[:32],
             {"uuid": uuid, "bodySha256": q.digest(canonical(body))}, save_storage)
    return {"state": "CONFIGURED_STOPPED_NOT_ADMITTED", "applicationUuid": uuid, "volumeIdentity": identities,
            "environmentSha256": q.digest(canonical(rpc.api("GET", "/applications/" + uuid + "/envs"))),
            "storageSha256": q.digest(canonical(rpc.api("GET", "/applications/" + uuid + "/storages")))}


def deploy(manifest, rpc):
    """Queue one digest deployment, only from the new v3 / schema26 state."""
    validate(manifest)
    verify_release(manifest["controllerCommit"])
    verify_v3(manifest, rpc)
    outcome = json.loads(read(ROOT / "art337-immutable-publication.outcome.json"))
    if outcome != {"state": "PUBLISHED", "journalSha256": q.digest(candidate(manifest))}:
        refuse("PUBLICATION_OUTCOME_UNKNOWN")
    no_queued_deployments(rpc, (ORIGINAL_APP, q.PLATFORM_APP, manifest["applicationUuid"]))
    expected = report(manifest, "artifact")["artifact"]
    verify_artifact(expected)
    uuid = manifest["applicationUuid"]
    # v2 lineage checks are preserved; neither journal nor deployment ref reset.
    installation_custody(rpc, uuid)
    if rpc.exclusive_canary(ORIGINAL_APP) != {"exclusive": True}:
        refuse("COMPETING_ORIGINAL_WRITER")
    q.verify_payload_stopped(rpc)
    with q.merchant_write_barrier(manifest, rpc):
        q.verify_live_commerce_snapshot(manifest, rpc, locked=True)
        verify_schema26(manifest, rpc)
        q.verify_live_payload_snapshot(manifest, rpc)
        validate_delivery(manifest, rpc, report(manifest, "delivery"))
        # Verified current ledger/fence immediately before queueing, not old proof.
        remote = json.loads(q.command(["/usr/local/bin/flexperiment-erasure", "read"]))
        mirror, mirror_sha = q.json_file(q.ERASURE_ROOT / "mirror" / "bundle.json", uid=1000)
        entries = mirror.get("entries", [])
        state, leases, unknown = q.current_fence(q.ERASURE_ROOT / "fence" / "erasure-fence.sqlite")
        if remote.get("state") != "REMOTE_VERIFIED" or remote.get("scope") != "canary" \
                or remote.get("sequence") != manifest["ledgerSequence"] \
                or mirror_sha != manifest["mirrorSha256"] or mirror.get("scope") != "canary" \
                or len(entries) != manifest["ledgerSequence"] \
                or state != ("canary", "OPEN", len(entries), entries[-1]["hash"], None) or leases or unknown:
            refuse("PRE_DEPLOYMENT_ERASURE_DRIFT")
        verify_release(manifest["controllerCommit"])
        def queue():
            result = rpc.api("POST", "/deploy?uuid=" + uuid + "&force=false")
            values = result.get("deployments", [])
            if len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", values[0].get("deployment_uuid", "")):
                refuse("DEPLOYMENT_RESPONSE_UNKNOWN")
            return {"deploymentUuid": values[0]["deployment_uuid"], "applicationUuid": uuid,
                    "reference": expected["reference"]}
        return once("commerce-deploy", {"uuid": uuid, "journalSha256": verify_v3(manifest, rpc),
                                      "reference": expected["reference"]}, queue)


def observe(manifest, rpc):
    validate(manifest)
    verify_v3(manifest, rpc)
    uuid = manifest["applicationUuid"]
    installation_custody(rpc, uuid)
    validate_delivery(manifest, rpc, report(manifest, "delivery"), running=True)
    container = rpc.container(uuid)
    artifact = report(manifest, "artifact")["artifact"]
    result = verify_runtime(artifact, container)
    inspected = json.loads(run(["docker", "inspect", container]))[0]
    original = rpc.api("GET", "/applications/" + ORIGINAL_APP + "/storages")
    required_mounts = []
    for row in original["persistent_storages"]:
        path = report(manifest, "delivery")["volumeIdentity"][row["name"]]["path"]
        required_mounts.append((path, row["mount_path"], True))
    for row in original["file_storages"]:
        destination, mode = row["mount_path"].rsplit(":", 1)
        required_mounts.append((row["fs_path"], destination, mode == "rw"))
    actual = [(row["Source"], row["Destination"], row["RW"]) for row in inspected["Mounts"]]
    if sorted(actual) != sorted(required_mounts) \
            or ORIGINAL_APP not in inspected["NetworkSettings"]["Networks"]["coolify"]["Aliases"]:
        refuse("INSTALLED_MOUNT_OR_ALIAS_DRIFT")
    image_config = json.loads(run(["docker", "image", "inspect", inspected["Image"]]))[0]["Config"]
    if any(inspected["Config"].get(key) != image_config.get(key) for key in ("User", "Entrypoint", "Cmd", "WorkingDir")):
        refuse("INSTALLED_EXECUTION_OVERRIDE")
    if run(["docker", "exec", container, "stat", "-c", "%a", "/app/.identity/identity.json"]).strip() != b"444":
        refuse("INSTALLED_IDENTITY_PERMISSIONS")
    readiness = json.loads(run(["docker", "exec", container, "curl", "--fail", "--silent",
                                "--max-time", "10", "http://127.0.0.1:3002/readyz"]))
    identity = json.loads(run(["docker", "exec", container, "curl", "--fail", "--silent",
                               "--max-time", "10", "http://127.0.0.1:3002/identity"]))
    if identity.get("sourceCommit") != TARGET or identity.get("service") != "commerce-v2" \
            or readiness.get("sourceCommit") != TARGET or readiness.get("ok") is not True \
            or readiness.get("foundationMode") is not False or readiness.get("core", {}).get("database") != "ok" \
            or readiness.get("core", {}).get("paymentMode") != "disabled" \
            or any(readiness.get("capabilities", {}).get(key) != value for key, value in
                   (("refref", "ready"), ("erasure", "qualified"), ("authEmail", "configured"), ("captcha", "configured"))):
        refuse("INSTALLED_READINESS_REFUSED")
    return {"state": "COMMERCE_ARTIFACT_READBACK_NOT_HARD_CUT_PASS", **result}


def adopt_delivery(manifest, rpc):
    """Change only the canary backup lookup after independently verified startup.

    The old config, old app, volumes and journal history are retained. The old
    owner deployment controller will refuse v3; it is never silently retargeted.
    """
    verify_release(manifest["controllerCommit"])
    observe(manifest, rpc)
    path = ROOT / "deploy-config.json"
    old = read(path)
    value = json.loads(old)
    if value["apps"]["canary"] != ORIGINAL_APP:
        refuse("OWNER_CONFIG_REPLAY_OR_DRIFT")
    new = copy.deepcopy(value)
    new["apps"]["canary"] = manifest["applicationUuid"]
    # Existing backup inspector supports directory binds and validates age
    # recipient, scope, two distinct RW paths and a single UUID runtime.
    spec = importlib.util.spec_from_file_location("immutable_scheduled_backup", Path(__file__).with_name("scheduled-backup.py"))
    backup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backup)
    backup.inspect("canary", new)
    pending = ROOT / "deploy-config.json.immutable-pending"
    previous = history_directory() / (q.digest(old) + "-deploy-config.json")
    def publish_config():
        if os.path.lexists(pending) or os.path.lexists(previous):
            refuse("OWNER_CONFIG_PUBLICATION_UNKNOWN")
        q.atomic_create(previous, old)
        q.atomic_create(pending, canonical(new))
        observe(manifest, rpc)
        if read(path) != old:
            refuse("OWNER_CONFIG_CHANGED_DURING_PUBLICATION")
        os.replace(pending, path)
        q.sync_directory(ROOT)
        if read(path) != canonical(new) or read(previous) != old:
            refuse("OWNER_CONFIG_READBACK_FAILED")
        return {"state": "BACKUP_LOOKUP_ADOPTED_NOT_CUTOVER_PASS", "configSha256": q.digest(canonical(new))}
    return once("commerce-backup-adopt", {"oldSha256": q.digest(old), "newSha256": q.digest(canonical(new))}, publish_config)


def stop_delivery(rpc):
    uuid = configured_uuid()
    source = rpc.api("GET", "/applications/" + ORIGINAL_APP)
    app = rpc.api("GET", "/applications/" + uuid)
    if app.get("name") != "flexperiment-commerce-v2-canary-immutable" \
            or app.get("environment_id") != source["environment_id"] \
            or app.get("destination_id") != source["destination_id"] \
            or app.get("fqdn") or app.get("ports_mappings"):
        refuse("STOP_TARGET_SCOPE_DRIFT")
    def stop():
        rpc.api("POST", "/applications/" + uuid + "/stop")
        return {"requested": True, "applicationUuid": uuid}
    return once("commerce-immutable-stop", {"uuid": uuid}, stop)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--reference")
    parser.add_argument("--controller")
    parser.add_argument("--name", default="commerce-deploy")
    parser.add_argument("--service", choices=SERVICES, default="commerce-v2")
    parser.add_argument("--operation", choices=("artifact", "create", "configure", "validate", "publish", "deploy", "observe", "adopt", "stop", "inspect-publication", "reconcile"), required=True)
    args = parser.parse_args()
    try:
        if args.operation == "artifact":
            print(json.dumps(inspect_artifact(args.reference, args.service)))
            return
        if args.operation == "inspect-publication":
            print(json.dumps(inspect_publication()))
            raise SystemExit(1)
        if args.operation == "reconcile":
            print(json.dumps(reconcile(args.name)))
            raise SystemExit(1)
        rpc = original_rpc()
        if args.operation == "create":
            verify_release(args.controller)
            artifact = json.loads(read(args.manifest))
            print(json.dumps(create_delivery(artifact, rpc)))
            return
        if args.operation == "stop":
            print(json.dumps(stop_delivery(rpc)))
            return
        if args.operation == "configure":
            verify_release(args.controller)
            print(json.dumps(configure_delivery(rpc)))
            return
        manifest = json.loads(read(args.manifest))
        validate(manifest)
        if args.operation == "publish":
            print(json.dumps({"state": "V3_PUBLISHED", "journalSha256": publish(manifest, rpc)}))
        elif args.operation == "observe":
            print(json.dumps(observe(manifest, rpc)))
        elif args.operation == "adopt":
            print(json.dumps(adopt_delivery(manifest, rpc)))
        elif args.operation == "deploy":
            result = deploy(manifest, rpc)
            print(json.dumps({"state": "QUEUED_NOT_PASS", "deploymentUuid": result["deploymentUuid"]}))
        else:
            verify_live(manifest, rpc)
            print(json.dumps({"state": "CONTINUATION_READY_NOT_EXECUTED"}))
    except Exception as error:
        # API errors may include request values. Return only our fixed refusal codes.
        print(json.dumps({"state": "HOLD", "reason": str(error) if isinstance(error, Refusal)
                          else "IMMUTABLE_RECOVERY_REFUSED"}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
