#!/usr/bin/env python3
"""One-time, fail-closed canary admission requalification. Never opens the fence.

The only write is --commit. It archives the exact predecessor and atomically
publishes a new, evidence-bound admission record. Invocation requires the
separate owner GO described in the ART-337 runbook.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone

sys.dont_write_bytecode = True

TARGET = "08523bdf38eeddf5e745ce04d05e1f980a7ced93"
PREDECESSOR = "84b1a6abcb43e9abf8f781e830f84822207c0dca"
PREDECESSOR_SHA256 = "eb60e0b11769e3f263c4e0e9bbb48fd8431f571ffba25a77fb0a37e8d7a352dc"
SCHEMAS = {
    "0025": "158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030",
    "0026": "c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39",
}
INSTALLATION = "6982499b-1567-46e4-b9e7-ab54416d8b8d"
READER_BINDING = "c41e2f717c83275cb4d4d5206b50b3994324c7f58f1c496126edee0b428a8490"
ROOT = pathlib.Path("/root/flexperiment-v2-owner")
ERASURE_ROOT = pathlib.Path("/var/lib/flexperiment-erasure-canary")
PLATFORM_APP = "ks8c2wmlle1kvdfuwbiwthe1"
PLATFORM_SOURCE = "b0ba13a3f58e5649afcc771da385959b14a06539"
PLATFORM_VOLUME = PLATFORM_APP + "-flexperiment-platform-v2-canary-editorial"
PLATFORM_TIMER = "platform-canary-backup.timer"
PLATFORM_SERVICE = "platform-canary-backup.service"
REQUIRED_FILES = ("inventory", "qualification", "restore", "boot", "backup")
APPROVED_NONZERO = {
    "commerce": {"cities": 3, "deployment_durability": 2, "launch_seed": 1, "offers": 1,
                 "playback_access_events": 1, "products": 1, "schema_identity": 1, "schema_migrations": 25},
    "payload": {"payload_migrations": 6},
}


class Refusal(ValueError):
    pass


def refuse(code):
    raise Refusal(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def private_bytes(path, uid=0, mode=0o600, limit=8_000_000):
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != mode \
            or info.st_nlink != 1 or not 0 < info.st_size <= limit:
        refuse("EVIDENCE_FILE_PERMISSIONS")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            refuse("EVIDENCE_FILE_RACE")
        raw = os.read(fd, limit + 1)
        if len(raw) != info.st_size:
            refuse("EVIDENCE_FILE_RACE")
        return raw
    finally:
        os.close(fd)


def json_file(path, uid=0, mode=0o600):
    raw = private_bytes(path, uid, mode)
    return json.loads(raw), digest(raw)


def command(args):
    return subprocess.check_output(args, timeout=60, stderr=subprocess.DEVNULL).decode()


def current_fence(path):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        state = db.execute("SELECT scope,state,sequence,head_hash,owner FROM fence_state WHERE id=1").fetchone()
        count = db.execute("SELECT COUNT(*), SUM(outcome='UNKNOWN') FROM fence_leases").fetchone()
        if db.execute("SELECT COUNT(*) FROM fence_state").fetchone()[0] != 1:
            refuse("FENCE_STATE_AMBIGUOUS")
        return state, count[0], count[1] or 0
    finally:
        db.close()


def volume_directory(rpc, uuid, mount_path, name):
    storage = rpc.api("GET", "/applications/" + uuid + "/storages")
    matches = [row for row in storage["persistent_storages"] if row.get("mount_path") == mount_path]
    if len(matches) != 1 or matches[0].get("name") != name or matches[0].get("host_path"):
        refuse("CANARY_VOLUME_DRIFT")
    volume = json.loads(command(["docker", "volume", "inspect", name]))
    if len(volume) != 1 or volume[0].get("Name") != name:
        refuse("CANARY_VOLUME_DRIFT")
    mountpoint = pathlib.Path(volume[0]["Mountpoint"])
    if mountpoint.is_symlink() or not mountpoint.is_dir():
        refuse("CANARY_VOLUME_DRIFT")
    directory = mountpoint.resolve(strict=True)
    return directory


def no_writable_fd(paths):
    identities = set()
    for path in paths:
        if path.exists():
            info = os.stat(path)
            if not stat.S_ISREG(info.st_mode):
                refuse("SQLITE_FILE_INVALID")
            identities.add((info.st_dev, info.st_ino))
    if not identities:
        refuse("SQLITE_FILE_MISSING")
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            for fd in os.listdir("/proc/" + pid + "/fd"):
                try:
                    info = os.stat("/proc/" + pid + "/fd/" + fd)
                    if (info.st_dev, info.st_ino) not in identities:
                        continue
                    with open("/proc/" + pid + "/fdinfo/" + fd) as source:
                        flags = next(line.split()[1] for line in source if line.startswith("flags:"))
                    if int(flags, 8) & 3:
                        refuse("COMPETING_SQLITE_WRITER")
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, ProcessLookupError):
            continue


def no_service_token_process(token):
    secret = token.encode()
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        for name in ("environ", "cmdline"):
            try:
                with open("/proc/" + pid + "/" + name, "rb") as source:
                    raw = source.read(1_048_577)
                if len(raw) > 1_048_576:
                    refuse("PAYLOAD_PROCESS_CENSUS_LIMIT")
                if secret in raw:
                    refuse("PAYLOAD_SERVICE_TOKEN_PROCESS_ACTIVE")
            except (FileNotFoundError, ProcessLookupError):
                continue


def verify_payload_stopped(rpc):
    app = rpc.api("GET", "/applications/" + PLATFORM_APP)
    if app.get("uuid") != PLATFORM_APP or app.get("name") != "flexperiment-platform-v2-canary" \
            or app.get("git_repository") != "ArtGurianov/flexperiment" \
            or app.get("git_commit_sha") != PLATFORM_SOURCE \
            or not str(app.get("status", "")).startswith(("exited", "stopped")) \
            or app.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or rpc.container(PLATFORM_APP, True):
        refuse("PAYLOAD_RUNTIME_ACTIVE_OR_UNKNOWN")
    rows = rpc.api("GET", "/applications/" + PLATFORM_APP + "/envs")
    jobs = [row for row in rows if row.get("key") == "PAYLOAD_JOBS_ENABLED" and not row.get("is_preview")]
    if len(jobs) != 1 or rpc.env_value(jobs[0]) != "false" or jobs[0].get("is_runtime") is not True \
            or any(row.get("key") == "PAYLOAD_JOBS_ENABLED" and row.get("is_preview") for row in rows):
        refuse("PAYLOAD_JOBS_CONFIGURATION_DRIFT")
    tokens = [row for row in rows if row.get("key") == "PLATFORM_COMMERCE_SERVICE_TOKEN" and not row.get("is_preview")]
    if len(tokens) != 1 or tokens[0].get("is_runtime") is not True \
            or any(row.get("key") == "PLATFORM_COMMERCE_SERVICE_TOKEN" and row.get("is_preview") for row in rows):
        refuse("PAYLOAD_SERVICE_TOKEN_BINDING_DRIFT")
    token = rpc.env_value(tokens[0])
    if not isinstance(token, str) or len(token) < 32 or any(character in token for character in ("\n", "\r", "\0")):
        refuse("PAYLOAD_SERVICE_TOKEN_BINDING_DRIFT")
    merchant = rpc.private_json(str(ROOT / "deploy-config.json"))["apps"]["canary"]
    merchant_rows = rpc.api("GET", "/applications/" + merchant + "/envs")
    accepted = [row for row in merchant_rows if row.get("key") == "PLATFORM_SERVICE_TOKEN" and not row.get("is_preview")]
    if len(accepted) != 1 or rpc.env_value(accepted[0]) != token or accepted[0].get("is_runtime") is not True:
        refuse("PAYLOAD_SERVICE_TOKEN_BINDING_DRIFT")
    for unit in (PLATFORM_TIMER, PLATFORM_SERVICE):
        active = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=10)
        if active.stdout.strip() != "inactive":
            refuse("PAYLOAD_JOB_ACTIVE_OR_UNKNOWN")
    enabled = subprocess.run(["systemctl", "is-enabled", PLATFORM_TIMER], capture_output=True, text=True, timeout=10)
    if enabled.stdout.strip() not in ("disabled", "masked"):
        refuse("PAYLOAD_TIMER_ENABLED")
    units = command(["systemctl", "list-units", "--all", "--no-legend", "--no-pager"])
    for line in units.splitlines():
        fields = line.split()
        unit = fields[1] if fields and fields[0] == "●" and len(fields) > 1 else fields[0] if fields else ""
        if ("platform-canary" in unit or "payload-canary" in unit) \
                and unit not in (PLATFORM_TIMER, PLATFORM_SERVICE):
            refuse("PAYLOAD_UNKNOWN_JOB_UNIT")
    directory = volume_directory(rpc, PLATFORM_APP, "/var/lib/flexperiment-platform-canary", PLATFORM_VOLUME)
    running = command(["docker", "ps", "-q"]).split()
    others = json.loads(command(["docker", "inspect", *running])) if running else []
    if any(value.partition("=")[2] == token for container in others for value in container.get("Config", {}).get("Env", [])):
        refuse("PAYLOAD_SERVICE_TOKEN_CONTAINER_ACTIVE")
    if any(mount.get("RW") and pathlib.Path(mount["Source"]).resolve() == directory
           for container in others for mount in container["Mounts"]):
        refuse("PAYLOAD_COMPETING_MOUNT")
    no_writable_fd((directory / "platform.sqlite", directory / "platform.sqlite-wal"))
    no_service_token_process(token)


def commerce_database_path(manifest, rpc):
    uuid = rpc.private_json(str(ROOT / "deploy-config.json"))["apps"]["canary"]
    storage = rpc.api("GET", "/applications/" + uuid + "/storages")
    matches = [row for row in storage["persistent_storages"]
               if row.get("mount_path") == "/var/lib/flexperiment-v2" and not row.get("host_path")]
    if len(matches) != 1 or not matches[0]["name"].startswith(uuid + "-"):
        refuse("CANARY_VOLUME_DRIFT")
    directory = volume_directory(rpc, uuid, "/var/lib/flexperiment-v2", matches[0]["name"])
    source_path = directory / "commerce.sqlite"
    inventory = checked_report(manifest, "inventory")
    expected = inventory["snapshots"]["commerce"]
    if expected.get("source_before", {}).get("path") != str(source_path) \
            or expected.get("source_after", {}).get("path") != str(source_path) \
            or not re.fullmatch(r"[0-9a-f]{64}", expected.get("snapshot_sha256", "")):
        refuse("INVENTORY_SOURCE_DRIFT")
    if source_path.is_symlink() or not source_path.is_file() or os.stat(source_path).st_nlink != 1:
        refuse("MERCHANT_DATABASE_INVALID")
    info = os.stat(source_path)
    for endpoint in ("source_before", "source_after"):
        identity = expected.get(endpoint, {})
        if identity.get("device") != info.st_dev or identity.get("inode") != info.st_ino:
            refuse("INVENTORY_SOURCE_DRIFT")
    return source_path, expected


def online_backup_sha256(source_path, check_foreign_keys):
    with tempfile.TemporaryDirectory(prefix="art337-live-", dir=ROOT) as temporary:
        destination_path = pathlib.Path(temporary) / "commerce.sqlite"
        source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=0)
        destination = sqlite3.connect(destination_path, timeout=0)
        try:
            deadline = time.monotonic() + 10
            def progress(status, _remaining, _total):
                if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED) or time.monotonic() > deadline:
                    refuse("LIVE_SNAPSHOT_BUSY_OR_TIMEOUT")
            source.backup(destination, pages=64, progress=progress, sleep=0.05)
            if destination.execute("PRAGMA integrity_check").fetchone() != ("ok",) \
                    or (check_foreign_keys and destination.execute("PRAGMA foreign_key_check").fetchone() is not None):
                refuse("MERCHANT_SNAPSHOT_INTEGRITY")
        finally:
            destination.close()
            source.close()
        with open(destination_path, "rb") as snapshot:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: snapshot.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()


def verify_live_commerce_snapshot(manifest, rpc, locked=False):
    source_path, expected = commerce_database_path(manifest, rpc)
    if online_backup_sha256(source_path, True) != expected["snapshot_sha256"]:
        refuse("LIVE_COMMERCE_INVENTORY_DRIFT")
    if not locked and rpc.exclusive_canary(rpc.private_json(str(ROOT / "deploy-config.json"))["apps"]["canary"]) \
            != {"exclusive": True}:
        refuse("COMPETING_WRITER_OR_RUNTIME")
    return expected["snapshot_sha256"]


def verify_live_payload_snapshot(manifest, rpc):
    directory = volume_directory(rpc, PLATFORM_APP, "/var/lib/flexperiment-platform-canary", PLATFORM_VOLUME)
    source_path = directory / "platform.sqlite"
    expected = checked_report(manifest, "inventory")["snapshots"]["payload"]
    if source_path.is_symlink() or not source_path.is_file() or source_path.stat().st_nlink != 1 \
            or not re.fullmatch(r"[0-9a-f]{64}", expected.get("snapshot_sha256", "")):
        refuse("PAYLOAD_DATABASE_INVALID")
    info = source_path.stat()
    for endpoint in ("source_before", "source_after"):
        identity = expected.get(endpoint, {})
        if identity.get("path") != str(source_path) or identity.get("device") != info.st_dev \
                or identity.get("inode") != info.st_ino:
            refuse("PAYLOAD_INVENTORY_SOURCE_DRIFT")
    if online_backup_sha256(source_path, False) != expected["snapshot_sha256"]:
        refuse("LIVE_PAYLOAD_INVENTORY_DRIFT")
    no_writable_fd((source_path, directory / "platform.sqlite-wal"))
    return expected["snapshot_sha256"]


@contextmanager
def merchant_write_barrier(manifest, rpc):
    """Block new SQLite writers until the admission replacement is read back.

    A second read-only connection performs backup: sqlite3 backup cannot run
    from the same connection while BEGIN IMMEDIATE is active.
    """
    source_path, _ = commerce_database_path(manifest, rpc)
    connection = sqlite3.connect(source_path.as_uri() + "?mode=rw", uri=True, timeout=0, isolation_level=None)
    try:
        try:
            connection.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError:
            refuse("MERCHANT_WRITE_BARRIER_REFUSED")
        yield
    finally:
        connection.rollback()
        connection.close()


def checked_report(manifest, key):
    entry = manifest["files"][key]
    if set(entry) != {"path", "sha256"} or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
        refuse("EVIDENCE_DESCRIPTOR_INVALID")
    path = pathlib.Path(entry["path"])
    if not path.is_absolute() or path.is_symlink():
        refuse("EVIDENCE_PATH_INVALID")
    report, actual = json_file(path)
    if actual != entry["sha256"]:
        refuse("EVIDENCE_DIGEST_MISMATCH")
    return report


def verify_reports(manifest):
    if set(manifest.get("files", {})) != set(REQUIRED_FILES):
        refuse("EVIDENCE_SET_INVALID")
    inventory = checked_report(manifest, "inventory")
    qualification = checked_report(manifest, "qualification")
    restore = checked_report(manifest, "restore")
    boot = checked_report(manifest, "boot")
    backup = checked_report(manifest, "backup")
    if inventory.get("environment") != "canary-v2" or inventory.get("issue") != "ART-329" \
            or inventory.get("snapshots", {}).get("commerce", {}).get("integrity_check") != "ok" \
            or inventory.get("snapshots", {}).get("payload", {}).get("integrity_check") != "ok":
        refuse("INVENTORY_INVALID")
    if backup.get("version") != 1 or backup.get("scope") != "canary" or backup.get("sourceCommit") != PREDECESSOR \
            or backup.get("state") != "READBACK_PASS" or backup.get("previousChainReadback") != "PASS" \
            or backup.get("recoveryKeys") != "AVAILABLE" or set(backup.get("archives", {})) != {"commerce", "payload"}:
        refuse("BACKUP_READBACK_INVALID")
    chain = backup.get("previousChainObjects")
    if not isinstance(chain, list) or not chain or any(not isinstance(row, dict) for row in chain) \
            or len({row.get("object") for row in chain}) != len(chain) or any(
                not isinstance(row.get("object"), str) or not row["object"]
                or not re.fullmatch(r"[0-9a-f]{64}", row.get("sha256", ""))
                or row.get("sha256") != row.get("remoteSha256") or not isinstance(row.get("size"), int) or row["size"] <= 0
                for row in chain):
        refuse("BACKUP_CHAIN_READBACK_INVALID")
    backup_time = datetime.fromisoformat(backup["recordedAt"])
    if backup_time.tzinfo is None or abs((datetime.now(timezone.utc) - backup_time).total_seconds()) > 3600:
        refuse("BACKUP_READBACK_STALE")
    for kind in ("commerce", "payload"):
        archive = backup["archives"][kind]
        path = pathlib.Path(archive["path"])
        if not path.is_absolute() or archive.get("snapshotSha256") != inventory["snapshots"][kind]["snapshot_sha256"] \
                or archive.get("remoteSha256") != archive.get("sha256"):
            refuse("BACKUP_SNAPSHOT_BINDING_INVALID")
        ciphertext = private_bytes(path)
        if digest(ciphertext) != archive.get("sha256") or len(ciphertext) != archive.get("size"):
            refuse("BACKUP_ARCHIVE_DRIFT")
    for kind, baseline in APPROVED_NONZERO.items():
        tables = inventory.get("inventories", {}).get(kind, {}).get("tables")
        if not isinstance(tables, list) or any(not isinstance(row, dict) for row in tables):
            refuse("INVENTORY_SCOPE_DRIFT")
        counts = {row.get("table"): row.get("count") for row in tables if row.get("count")}
        if len(tables) != len({row.get("table") for row in tables}) or counts != baseline:
            refuse("INVENTORY_SCOPE_DRIFT")
    snapshot_sha = inventory["snapshots"]["commerce"]["snapshot_sha256"]
    proof_scripts = {kind: digest(pathlib.Path(__file__).with_name(name).read_bytes()) for kind, name in
                     (("restore", "art337-proof-restores.mjs"), ("boot", "art337-proof-boot.mjs"))}
    if qualification.get("proofScriptSha256") != proof_scripts["restore"] \
            or qualification.get("bootScriptSha256") != proof_scripts["boot"]:
        refuse("PROOF_SCRIPT_DRIFT")
    if qualification.get("sourceCommit") != TARGET or qualification.get("result", {}).get("target") != TARGET \
            or qualification["result"].get("result") != "PASS" \
            or qualification.get("freshCommerceSnapshotSha256") != snapshot_sha \
            or qualification.get("imageId") != manifest.get("imageId"):
        refuse("TARGET_PROOF_INVALID")
    proof_time = datetime.fromisoformat(qualification["recordedAt"])
    if proof_time.tzinfo is None or abs((datetime.now(timezone.utc) - proof_time).total_seconds()) > 3600:
        refuse("TARGET_PROOF_STALE")
    if restore.get("target") != TARGET or restore.get("result") != "PASS" \
            or restore.get("proofs") != qualification["result"].get("proofs"):
        refuse("RESTORE_PROOF_INVALID")
    proofs = {p.get("kind"): p for p in restore["proofs"]}
    if set(proofs) != {"synthetic25", "synthetic26", "current26"}:
        refuse("RESTORE_CASES_MISSING")
    for kind, migrations, users in (("synthetic25", 25, 1), ("synthetic26", 26, 1), ("current26", 26, 0)):
        proof = proofs[kind]
        if proof.get("migrationCount") != migrations or proof.get("beforeUsers") != users \
                or proof.get("integrity") != "ok" or proof.get("foreignKeys") != "ok" \
                or proof.get("appliedSequence") != manifest["ledgerSequence"] \
                or proof.get("erasedAccounts") != users:
            refuse("RESTORE_CASE_FAILED")
    if boot.get("target") != TARGET or boot.get("result") != "BOOT_PASS" \
            or boot.get("fence") != "OPEN" or boot.get("leases") != 0 \
            or boot.get("erasure") != "qualified" or boot.get("integrity") != "ok" \
            or boot.get("foreignKeys") != "ok" or boot.get("afterMigrations") != 26:
        refuse("BOOT_PROOF_INVALID")
    if manifest.get("schemaFingerprints") != SCHEMAS:
        refuse("SCHEMA_SET_INVALID")
    if manifest.get("ownerDecision") != "ZERO_REAL_DATA_CONFIRMED_WITH_CLASSIFIED_SYNTHETIC_EVENT":
        refuse("INVENTORY_OWNER_DECISION_MISSING")
    recorded = datetime.fromisoformat(inventory["generated_at_utc"])
    if recorded.tzinfo is None or abs((datetime.now(timezone.utc) - recorded).total_seconds()) > 3600:
        refuse("INVENTORY_STALE")
    return qualification


def verify_live(manifest, rpc, locked=False, admitted=False, expected_source=PREDECESSOR):
    if expected_source not in (PREDECESSOR, TARGET) or (not admitted and expected_source != PREDECESSOR):
        refuse("SOURCE_TRANSITION_INVALID")
    config = rpc.private_json(str(ROOT / "deploy-config.json"))
    apps = config["apps"]
    if set(apps) != {"canary", "production"} or apps["canary"] == apps["production"]:
        refuse("TARGET_TOPOLOGY_INVALID")
    uuid = apps["canary"]
    rpc.erasure_environment(uuid)
    app = rpc.api("GET", "/applications/" + uuid)
    if app.get("uuid") != uuid or app.get("name") != "flexperiment-commerce-v2-canary" \
            or app.get("git_commit_sha") != expected_source or app.get("git_repository") != "ArtGurianov/flexperiment" \
            or app.get("dockerfile_location") != "/Dockerfile.commerce-v2" \
            or app.get("settings", {}).get("is_auto_deploy_enabled") is not False \
            or not str(app.get("status", "")).startswith(("exited", "stopped")):
        refuse("PREDECESSOR_APP_IDENTITY_DRIFT")
    rows = rpc.api("GET", "/applications/" + uuid + "/envs")
    source = [row for row in rows if row.get("key") == "SOURCE_COMMIT" and not row.get("is_preview")]
    if len(source) != 1 or rpc.env_value(source[0]) != expected_source \
            or source[0].get("is_runtime") is not True:
        refuse("PREDECESSOR_ENVIRONMENT_DRIFT")
    if locked and rpc.container(uuid, True):
        refuse("COMPETING_WRITER_OR_RUNTIME")
    if not locked and rpc.exclusive_canary(uuid) != {"exclusive": True}:
        refuse("COMPETING_WRITER_OR_RUNTIME")
    verify_payload_stopped(rpc)
    verify_live_payload_snapshot(manifest, rpc)
    verify_live_commerce_snapshot(manifest, rpc, locked=locked)
    old = private_bytes(ROOT / "erasure-admission.json")
    if admitted:
        candidate = journal_candidate(manifest)
        previous = private_bytes(ROOT / "erasure-admission-history" / (PREDECESSOR_SHA256 + ".json"))
        readback_published(manifest, previous, candidate)
        rpc.verify_requalified_admission(json.loads(old))
        old = previous
    if digest(old) != PREDECESSOR_SHA256:
        refuse("PREDECESSOR_DRIFT")
    previous = json.loads(old)
    if previous.get("sourceCommit") != PREDECESSOR or previous.get("recovery") != "PASS" \
            or previous.get("installationId") != INSTALLATION \
            or previous.get("readerBindingSha256") != READER_BINDING:
        refuse("PREDECESSOR_INVALID")
    policy, _ = json_file(ERASURE_ROOT / "installation" / "installation.json", mode=0o444)
    if policy.get("scope") != "canary" or policy.get("state") != "REQUIRED" \
            or policy.get("installationId") != INSTALLATION \
            or policy.get("readerBindingSha256") != READER_BINDING:
        refuse("INSTALLATION_BINDING_INVALID")
    remote = json.loads(command(["/usr/local/bin/flexperiment-erasure", "read"]))
    if remote.get("state") != "REMOTE_VERIFIED" or remote.get("scope") != "canary" \
            or remote.get("sequence") != manifest["ledgerSequence"]:
        refuse("REMOTE_LEDGER_DRIFT")
    bundle, bundle_sha = json_file(ERASURE_ROOT / "mirror" / "bundle.json", uid=1000)
    entries = bundle.get("entries")
    if not re.fullmatch(r"[0-9a-f]{64}", manifest.get("mirrorSha256", "")) \
            or bundle.get("scope") != "canary" or not isinstance(entries, list) \
            or len(entries) != manifest["ledgerSequence"] \
            or bundle_sha != manifest["mirrorSha256"]:
        refuse("MIRROR_DRIFT")
    head = entries[-1]["hash"] if entries else "EMPTY"
    state, leases, unknown = current_fence(ERASURE_ROOT / "fence" / "erasure-fence.sqlite")
    if not state or state[0] != "canary" or state[1] not in ("CLOSED", "OPEN") \
            or state[2:] != (len(entries), head, None) or leases or unknown:
        refuse("FENCE_NOT_DRAINED")
    image = manifest["imageId"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        refuse("IMAGE_ID_INVALID")
    inspected = json.loads(command(["docker", "image", "inspect", image]))
    if len(inspected) != 1 or inspected[0].get("Id") != image:
        refuse("IMAGE_ID_DRIFT")
    identity = json.loads(command(["docker", "run", "--rm", "--network", "none", "--read-only",
                                   "--entrypoint", "cat", image, "/app/.identity/identity.json"]))
    if identity != {"schema": "flexperiment.build-identity/1", "service": "commerce-v2", "sourceCommit": TARGET}:
        refuse("IMAGE_SOURCE_DRIFT")
    return old


def verify_start_admission(rpc, expected_source, locked=False):
    manifest, _ = json_file(ROOT / "art337-execution-manifest.json")
    verify_manifest(manifest)
    verify_reports(manifest)
    verify_live(manifest, rpc, locked=locked, admitted=True, expected_source=expected_source)
    backup = checked_report(manifest, "backup")
    commerce = backup["archives"]["commerce"]
    return {"qualified": True, "sourceCommit": TARGET, "predecessorSourceCommit": PREDECESSOR,
            "stoppedReplacement": True, "backup": {"sha256": commerce["sha256"], "size": commerce["size"],
                                                       "evidenceSha256": manifest["files"]["backup"]["sha256"]}}


def record(manifest):
    if set(manifest.get("files", {})) != set(REQUIRED_FILES) or any(
            not re.fullmatch(r"[0-9a-f]{64}", manifest["files"][key].get("sha256", "")) for key in REQUIRED_FILES):
        refuse("EVIDENCE_SET_INVALID")
    snapshots = checked_report(manifest, "inventory")["snapshots"]
    return {"version": 2, "scope": "canary", "sourceCommit": TARGET, "recovery": "PASS",
            "installationId": INSTALLATION, "readerBindingSha256": READER_BINDING,
            "previousSourceCommit": PREDECESSOR, "previousJournalSha256": PREDECESSOR_SHA256,
            "ledgerSequence": manifest["ledgerSequence"], "mirrorSha256": manifest["mirrorSha256"],
            "liveCommerceSnapshotSha256": snapshots["commerce"]["snapshot_sha256"],
            "livePayloadSnapshotSha256": snapshots["payload"]["snapshot_sha256"],
            "imageId": manifest["imageId"], "schemaFingerprints": SCHEMAS,
            "controllerSha256": digest(pathlib.Path(__file__).with_name("owner-rpc.py").read_bytes()),
            "requalifierSha256": digest(pathlib.Path(__file__).read_bytes()),
            "evidence": {key: manifest["files"][key]["sha256"] for key in REQUIRED_FILES},
            "qualifiedAt": manifest["qualifiedAt"], "ownerDecision": manifest["ownerDecision"]}


def atomic_create(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(raw)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                refuse("SHORT_EVIDENCE_WRITE")
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(path.parent)


def sync_directory(path):
    parent = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def journal_candidate(manifest):
    return (json.dumps(record(manifest), sort_keys=True, separators=(",", ":")) + "\n").encode()


def readback_published(manifest, old, candidate):
    history = ROOT / "erasure-admission-history"
    info = os.lstat(history)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700 \
            or digest(old) != PREDECESSOR_SHA256:
        refuse("ADMISSION_HISTORY_INVALID")
    if private_bytes(ROOT / "erasure-admission.json") != candidate \
            or private_bytes(history / (PREDECESSOR_SHA256 + ".json")) != old \
            or os.path.lexists(ROOT / "erasure-admission.json.requalification-pending"):
        refuse("ADMISSION_READBACK_FAILED")
    for key in REQUIRED_FILES:
        sha = manifest["files"][key]["sha256"]
        if digest(private_bytes(history / (sha + "-" + key + ".json"))) != sha:
            refuse("ADMISSION_READBACK_FAILED")
    return digest(candidate)


def inspect_publication(manifest):
    """Read-only reconciliation of an attempted write; never grants admission."""
    candidate = journal_candidate(manifest)
    active = private_bytes(ROOT / "erasure-admission.json")
    pending_path = ROOT / "erasure-admission.json.requalification-pending"
    pending = private_bytes(pending_path) if os.path.lexists(pending_path) else None
    if pending is not None and pending != candidate:
        refuse("PENDING_RECORD_UNKNOWN")
    history = ROOT / "erasure-admission-history"
    previous_path = history / (PREDECESSOR_SHA256 + ".json")
    if active == candidate:
        previous = private_bytes(previous_path)
        readback_published(manifest, previous, candidate)
        return {"state": "HOLD", "reason": "ALREADY_PUBLISHED_REQUIRES_REVIEW", "journalSha256": digest(active),
                "previousJournalSha256": PREDECESSOR_SHA256, "candidateSha256": digest(candidate), "pendingSha256": None}
    if digest(active) != PREDECESSOR_SHA256:
        refuse("ACTIVE_JOURNAL_UNKNOWN")
    if os.path.lexists(history):
        info = os.lstat(history)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            refuse("ADMISSION_HISTORY_INVALID")
        if os.path.lexists(previous_path) and private_bytes(previous_path) != active:
            refuse("ADMISSION_HISTORY_INVALID")
        for key in REQUIRED_FILES:
            sha = manifest["files"][key]["sha256"]
            path = history / (sha + "-" + key + ".json")
            if os.path.lexists(path) and digest(private_bytes(path)) != sha:
                refuse("ADMISSION_HISTORY_INVALID")
    return {"state": "HOLD", "reason": "UNPUBLISHED_REQUIRES_REVIEW", "journalSha256": digest(active),
            "previousJournalSha256": PREDECESSOR_SHA256, "candidateSha256": digest(candidate),
            "pendingSha256": digest(pending) if pending is not None else None}


def publish(manifest, old, recheck=None):
    candidate = journal_candidate(manifest)
    active = private_bytes(ROOT / "erasure-admission.json")
    if active == candidate:
        readback_published(manifest, old, candidate)
        refuse("ALREADY_PUBLISHED_REQUIRES_REVIEW")
    if active != old:
        refuse("PREDECESSOR_CHANGED_DURING_COMMIT")
    pending = ROOT / "erasure-admission.json.requalification-pending"
    if os.path.lexists(pending):
        refuse("PENDING_RECORD_UNKNOWN")
    history = ROOT / "erasure-admission-history"
    if history.is_symlink():
        refuse("HISTORY_PATH_INVALID")
    if not history.exists():
        history.mkdir(mode=0o700)
    info = os.lstat(history)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        refuse("HISTORY_PERMISSIONS")
    previous = history / (PREDECESSOR_SHA256 + ".json")
    if os.path.lexists(previous):
        refuse("HISTORY_ALREADY_PRESENT_REQUIRES_REVIEW")
    atomic_create(previous, old)
    for key in REQUIRED_FILES:
        expected = manifest["files"][key]["sha256"]
        source = pathlib.Path(manifest["files"][key]["path"])
        raw = private_bytes(source)
        if digest(raw) != expected:
            refuse("EVIDENCE_CHANGED_DURING_COMMIT")
        archived = history / (expected + "-" + key + ".json")
        if os.path.lexists(archived):
            refuse("EVIDENCE_ALREADY_PRESENT_REQUIRES_REVIEW")
        atomic_create(archived, raw)
    if os.path.lexists(pending):
        refuse("PENDING_RECORD_UNKNOWN")
    atomic_create(pending, candidate)
    if recheck is not None and recheck() != old:
        refuse("LIVE_STATE_CHANGED_DURING_COMMIT")
    if private_bytes(ROOT / "erasure-admission.json") != old:
        refuse("PREDECESSOR_CHANGED_DURING_COMMIT")
    os.replace(pending, ROOT / "erasure-admission.json")
    sync_directory(ROOT)
    return readback_published(manifest, old, candidate)


def verify_manifest(manifest):
    if manifest.get("version") != 1 or manifest.get("scope") != "canary" \
            or manifest.get("sourceCommit") != TARGET or manifest.get("previousSourceCommit") != PREDECESSOR \
            or manifest.get("installationId") != INSTALLATION \
            or manifest.get("readerBindingSha256") != READER_BINDING \
            or not isinstance(manifest.get("ledgerSequence"), int) or manifest["ledgerSequence"] < 0:
        refuse("MANIFEST_IDENTITY_INVALID")
    qualified_at = datetime.fromisoformat(manifest["qualifiedAt"])
    if qualified_at.tzinfo is None or abs((datetime.now(timezone.utc) - qualified_at).total_seconds()) > 3600:
        refuse("QUALIFICATION_STALE")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--commit", action="store_true", help="Requires reviewed owner GO TO EXECUTE")
    parser.add_argument("--inspect-publication", action="store_true", help="Read-only old/new/pending reconciliation; always HOLD")
    args = parser.parse_args()
    try:
        manifest, _ = json_file(args.manifest)
        if manifest.get("version") != 1 or manifest.get("scope") != "canary" \
                or manifest.get("sourceCommit") != TARGET or manifest.get("previousSourceCommit") != PREDECESSOR \
                or manifest.get("installationId") != INSTALLATION \
                or manifest.get("readerBindingSha256") != READER_BINDING \
                or not isinstance(manifest.get("ledgerSequence"), int) or manifest["ledgerSequence"] < 0:
            refuse("MANIFEST_IDENTITY_INVALID")
        if args.inspect_publication:
            if args.commit:
                refuse("INSPECTION_CANNOT_COMMIT")
            print(json.dumps(inspect_publication(manifest)), file=sys.stderr)
            raise SystemExit(1)
        verify_manifest(manifest)
        if private_bytes(ROOT / "erasure-admission.json") == journal_candidate(manifest):
            previous = private_bytes(ROOT / "erasure-admission-history" / (PREDECESSOR_SHA256 + ".json"))
            sha = readback_published(manifest, previous, journal_candidate(manifest))
            print(json.dumps({"state": "HOLD", "reason": "ALREADY_PUBLISHED_REQUIRES_REVIEW",
                              "sourceCommit": TARGET, "journalSha256": sha}), file=sys.stderr)
            raise SystemExit(1)
        verify_reports(manifest)
        spec = importlib.util.spec_from_file_location("owner_rpc", pathlib.Path(__file__).with_name("owner-rpc.py"))
        rpc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rpc)
        old = verify_live(manifest, rpc)
        if args.commit:
            with merchant_write_barrier(manifest, rpc):
                if verify_live(manifest, rpc, locked=True) != old:
                    refuse("LIVE_STATE_CHANGED_DURING_COMMIT")
                sha = publish(manifest, old, lambda: verify_live(manifest, rpc, locked=True))
            print(json.dumps({"state": "ADMISSION_REQUALIFIED", "sourceCommit": TARGET, "journalSha256": sha}))
        else:
            print(json.dumps({"state": "QUALIFICATION_READY", "sourceCommit": TARGET,
                              "previousJournalSha256": digest(old), "candidateSha256": digest(json.dumps(record(manifest), sort_keys=True, separators=(",", ":")).encode() + b"\n")}))
    except Refusal as error:
        print(json.dumps({"state": "HOLD", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"state": "HOLD", "reason": "ART337_REQUALIFICATION_REFUSED"}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
