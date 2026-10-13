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
from datetime import datetime, timezone

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
REQUIRED_FILES = ("inventory", "qualification", "restore", "boot")
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
    if inventory.get("environment") != "canary-v2" or inventory.get("issue") != "ART-329" \
            or inventory.get("snapshots", {}).get("commerce", {}).get("integrity_check") != "ok" \
            or inventory.get("snapshots", {}).get("payload", {}).get("integrity_check") != "ok":
        refuse("INVENTORY_INVALID")
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


def verify_live(manifest, rpc):
    config = rpc.private_json(str(ROOT / "deploy-config.json"))
    apps = config["apps"]
    if set(apps) != {"canary", "production"} or apps["canary"] == apps["production"]:
        refuse("TARGET_TOPOLOGY_INVALID")
    uuid = apps["canary"]
    rpc.erasure_environment(uuid)
    app = rpc.api("GET", "/applications/" + uuid)
    if app.get("uuid") != uuid or app.get("name") != "flexperiment-commerce-v2-canary" \
            or app.get("git_commit_sha") != PREDECESSOR or app.get("git_repository") != "ArtGurianov/flexperiment" \
            or app.get("dockerfile_location") != "/Dockerfile.commerce-v2" \
            or app.get("settings", {}).get("is_auto_deploy_enabled") is not False:
        refuse("PREDECESSOR_APP_IDENTITY_DRIFT")
    rows = rpc.api("GET", "/applications/" + uuid + "/envs")
    source = [row for row in rows if row.get("key") == "SOURCE_COMMIT" and not row.get("is_preview")]
    if len(source) != 1 or rpc.env_value(source[0]) != PREDECESSOR \
            or source[0].get("is_runtime") is not True:
        refuse("PREDECESSOR_ENVIRONMENT_DRIFT")
    if rpc.exclusive_canary(uuid) != {"exclusive": True}:
        refuse("COMPETING_WRITER_OR_RUNTIME")
    old = private_bytes(ROOT / "erasure-admission.json")
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


def record(manifest):
    return {"version": 2, "scope": "canary", "sourceCommit": TARGET, "recovery": "PASS",
            "installationId": INSTALLATION, "readerBindingSha256": READER_BINDING,
            "previousSourceCommit": PREDECESSOR, "previousJournalSha256": PREDECESSOR_SHA256,
            "ledgerSequence": manifest["ledgerSequence"], "mirrorSha256": manifest["mirrorSha256"],
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
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def publish(manifest, old):
    history = ROOT / "erasure-admission-history"
    if history.is_symlink():
        refuse("HISTORY_PATH_INVALID")
    if not history.exists():
        history.mkdir(mode=0o700)
    info = os.lstat(history)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        refuse("HISTORY_PERMISSIONS")
    previous = history / (PREDECESSOR_SHA256 + ".json")
    if previous.exists():
        if private_bytes(previous) != old:
            refuse("HISTORY_CONFLICT")
    else:
        atomic_create(previous, old)
    for key in REQUIRED_FILES:
        expected = manifest["files"][key]["sha256"]
        source = pathlib.Path(manifest["files"][key]["path"])
        raw = private_bytes(source)
        if digest(raw) != expected:
            refuse("EVIDENCE_CHANGED_DURING_COMMIT")
        archived = history / (expected + "-" + key + ".json")
        if archived.exists():
            if private_bytes(archived) != raw:
                refuse("EVIDENCE_HISTORY_CONFLICT")
        else:
            atomic_create(archived, raw)
    candidate = (json.dumps(record(manifest), sort_keys=True, separators=(",", ":")) + "\n").encode()
    pending = ROOT / "erasure-admission.json.requalification-pending"
    if pending.exists():
        refuse("PENDING_RECORD_UNKNOWN")
    atomic_create(pending, candidate)
    try:
        if private_bytes(ROOT / "erasure-admission.json") != old:
            refuse("PREDECESSOR_CHANGED_DURING_COMMIT")
        os.replace(pending, ROOT / "erasure-admission.json")
        parent = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if pending.exists():
            pending.unlink()
    if private_bytes(ROOT / "erasure-admission.json") != candidate or private_bytes(previous) != old \
            or any(digest(private_bytes(history / (manifest["files"][key]["sha256"] + "-" + key + ".json")))
                   != manifest["files"][key]["sha256"] for key in REQUIRED_FILES):
        refuse("ADMISSION_READBACK_FAILED")
    return digest(candidate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--commit", action="store_true", help="Requires reviewed owner GO TO EXECUTE")
    args = parser.parse_args()
    try:
        manifest, _ = json_file(args.manifest)
        if manifest.get("version") != 1 or manifest.get("scope") != "canary" \
                or manifest.get("sourceCommit") != TARGET or manifest.get("previousSourceCommit") != PREDECESSOR \
                or manifest.get("installationId") != INSTALLATION \
                or manifest.get("readerBindingSha256") != READER_BINDING \
                or not isinstance(manifest.get("ledgerSequence"), int) or manifest["ledgerSequence"] < 0:
            refuse("MANIFEST_IDENTITY_INVALID")
        qualified_at = datetime.fromisoformat(manifest["qualifiedAt"])
        if qualified_at.tzinfo is None or abs((datetime.now(timezone.utc) - qualified_at).total_seconds()) > 3600:
            refuse("QUALIFICATION_STALE")
        verify_reports(manifest)
        spec = importlib.util.spec_from_file_location("owner_rpc", pathlib.Path(__file__).with_name("owner-rpc.py"))
        rpc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rpc)
        old = verify_live(manifest, rpc)
        if args.commit:
            sha = publish(manifest, old)
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
