#!/usr/bin/env python3
"""Owner-only ciphertext transport/retention. No DB writes or secret output."""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = pathlib.Path("/root/flexperiment-v2-owner")
CONF = pathlib.Path("/etc/flexperiment/recovery")
LOCAL = pathlib.Path("/var/backups/flexperiment-commerce-v2")
S3_IMAGE = "rclone/rclone@sha256:74c51b8817e5431bd6d7ed27cb2a50d8ee78d77f6807b72a41ef6f898845942b"
MAX_AGE = 8 * 3600


def require(value, reason):
    if not value:
        raise ValueError(reason)


def private(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size > 0, "CUSTODY_INVALID")


def run(args):
    try:
        return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=180).stdout
    except (subprocess.SubprocessError, OSError):
        raise ValueError("COMMAND_FAILED") from None


def digest(path):
    sha256 = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def names(target, values, keep, current=None):
    pattern = re.compile(rf"^{target}-\d{{8}}T\d{{6}}Z-[a-f0-9]{{40}}-[a-f0-9-]{{36}}\.sqlite\.age$")
    candidates = {value for value in values if pattern.fullmatch(value)}
    if current is not None:
        require(current in candidates, "VERIFIED_ARCHIVE_NOT_LISTED")
        candidates.remove(current)
        keep -= 1  # Always retain this verified snapshot, even after a clock correction.
    return sorted(candidates, reverse=True)[keep:]


def state_path(target):
    return LOCAL / target / "status.json"


def write_state(target, data):
    directory = state_path(target).parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".status-", dir=directory)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(data, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, state_path(target))
        sync = os.open(directory, os.O_DIRECTORY)
        try:
            os.fsync(sync)
        finally:
            os.close(sync)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check(target, now):
    private(state_path(target))
    data = json.loads(state_path(target).read_text())
    require(data.get("status") == "SUCCESS" and data.get("target") == target
            and isinstance(data.get("verifiedAt"), int)
            and 0 <= now - data["verifiedAt"] <= MAX_AGE
            and re.fullmatch("[a-f0-9]{64}", data.get("sha256", "")), "BACKUP_STALE_OR_FAILED")
    return {"target": target, "status": "FRESH", "verifiedAt": data["verifiedAt"]}


def s3(directory, command):
    # Secrets never enter command arguments, host environment, output or state.
    script = '''set -eu
set -o pipefail
export RCLONE_LOG_LEVEL=ERROR RCLONE_CONFIG_CLOUD_TYPE=s3 RCLONE_CONFIG_CLOUD_PROVIDER=Other
export RCLONE_CONFIG_CLOUD_ENDPOINT=https://s3.cloud.ru RCLONE_CONFIG_CLOUD_REGION=ru-central-1
export RCLONE_CONFIG_CLOUD_FORCE_PATH_STYLE=true RCLONE_CONFIG_CLOUD_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_CLOUD_ACCESS_KEY_ID="$(cat /secrets/s3-access-key)"
export RCLONE_CONFIG_CLOUD_SECRET_ACCESS_KEY="$(cat /secrets/s3-secret-key)"
''' + command
    return run(["docker", "run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "-v", f"{CONF}:/secrets:ro", "-v", f"{directory}:/backup:ro",
                "--entrypoint", "/bin/sh", S3_IMAGE, "-c", script])


def inspect(target, config):
    apps = config.get("apps", {})
    require(set(apps) == {"canary", "production"} and apps["canary"] != apps["production"]
            and all(re.fullmatch("[a-z0-9]{24}", value) for value in apps.values()), "APP_SCOPE_INVALID")
    found = [name for name in run(["docker", "ps", "--format", "{{.Names}}"]).decode().splitlines()
             if re.fullmatch(re.escape(apps[target]) + r"-\d{8}T\d{6}", name)]
    require(len(found) == 1, "RUNTIME_NOT_UNIQUE")
    name = found[0]
    info = json.loads(run(["docker", "inspect", name]))[0]
    env = dict(value.split("=", 1) for value in info["Config"]["Env"] if "=" in value)
    require(env.get("COMMERCE_V2_ENVIRONMENT") == target
            and env.get("COMMERCE_V2_DATABASE_PATH") == "/var/lib/flexperiment-v2/commerce.sqlite"
            and env.get("COMMERCE_V2_BACKUP_PATH") == "/var/lib/flexperiment-v2-backups"
            and env.get("BUILD_IDENTITY_FILE") == "/app/.identity/identity.json", "RUNTIME_SCOPE_INVALID")
    mounts = {item["Destination"]: item for item in info["Mounts"]}
    data, backup = (mounts.get(path) for path in ("/var/lib/flexperiment-v2", "/var/lib/flexperiment-v2-backups"))
    require(data and backup and data.get("RW") and backup.get("RW")
            and data["Source"] != backup["Source"], "STORAGE_SCOPE_INVALID")
    recipient = (CONF / "age-recipient.txt").read_text().strip()
    require(re.fullmatch(r"age1[0-9a-z]{58}", recipient)
            and env.get("COMMERCE_V2_BACKUP_AGE_RECIPIENT") == recipient, "RECIPIENT_DIFFERS")
    return name


def backup(target, now):
    private(ROOT / "deploy-config.json")
    for key in ("s3-access-key", "s3-secret-key"):
        private(CONF / key)
    container = inspect(target, json.loads((ROOT / "deploy-config.json").read_text()))
    # CLI opens read-only and never migrates/seeds; works in either runtime mode.
    proof = json.loads(run(["docker", "exec", container, "node", "--import", "tsx", "commerce-v2/src/backup-cli.ts"]))
    pattern = rf"^{target}-([a-f0-9]{{40}})-([a-f0-9-]{{36}})\.sqlite\.age$"
    match = re.fullmatch(pattern, proof.get("filename", ""))
    require(match and isinstance(proof.get("size"), int) and proof["size"] > 0
            and re.fullmatch("[a-f0-9]{64}", proof.get("sha256", "")), "BACKUP_PROOF_INVALID")
    directory = LOCAL / target
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{target}-{stamp}-{match[1]}-{uuid.uuid4()}.sqlite.age"
    archive = directory / filename
    require(not archive.exists(), "ARCHIVE_COLLISION")
    run(["docker", "cp", f"{container}:/var/lib/flexperiment-v2-backups/{proof['filename']}", str(archive)])
    archive.chmod(0o600)
    require(archive.stat().st_size == proof["size"] and digest(archive) == proof["sha256"], "LOCAL_HASH_DIFFERS")
    with archive.open("rb") as handle:
        os.fsync(handle.fileno())
    descriptor = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    remote = f"cloud:art-backups/flexperiment/commerce-v2/{target}/sqlite"
    s3(directory, f'rclone copyto "/backup/{filename}" "{remote}/{filename}"')
    # Stream remote ciphertext through SHA256 inside the pinned client: no unbounded host buffer.
    readback = s3(directory, f'rclone cat "{remote}/{filename}" | sha256sum').decode().split()
    require(len(readback) == 2 and readback[0] == proof["sha256"], "REMOTE_HASH_DIFFERS")
    remote_names = s3(directory, f'rclone lsf --files-only "{remote}"').decode().splitlines()
    for old in names(target, remote_names, 100, filename):
        s3(directory, f'rclone deletefile "{remote}/{old}"')
    for old in names(target, [item.name for item in directory.iterdir() if item.is_file() and not item.is_symlink()], 7, filename):
        (directory / old).unlink()
    # Remove only this verified encrypted snapshot from the app's backup volume.
    run(["docker", "exec", container, "node", "-e", "require('node:fs').unlinkSync(process.argv[1])",
         f"/var/lib/flexperiment-v2-backups/{proof['filename']}"])
    result = {"target": target, "status": "SUCCESS", "verifiedAt": now,
              "sourceCommit": match[1], "filename": filename, "sha256": proof["sha256"], "size": proof["size"]}
    write_state(target, result)
    return result


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ("canary", "production")
            and sys.argv[2] in ("backup", "check") and os.geteuid() == 0, "OWNER_SCOPE_REQUIRED")
    target, command = sys.argv[1:]
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    directory = LOCAL / target
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = None
        if command == "backup":
            if state_path(target).exists():
                private(state_path(target))
                old = json.loads(state_path(target).read_text())
                previous = old if old.get("status") == "SUCCESS" else old.get("lastSuccess")
            # Crash/SIGTERM/timeout cannot leave a preceding SUCCESS appearing
            # to attest the newly interrupted attempt. Unit failure is additional evidence.
            write_state(target, {"target": target, "status": "IN_PROGRESS", "attemptedAt": now, "lastSuccess": previous})
        try:
            result = check(target, now) if command == "check" else backup(target, now)
        except Exception:
            if command == "backup":
                write_state(target, {"target": target, "status": "FAILED", "attemptedAt": now, "lastSuccess": previous})
            raise
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("V2_SCHEDULED_BACKUP_STOP", file=sys.stderr)
        sys.exit(1)
