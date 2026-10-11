#!/usr/bin/env python3
"""Isolated Platform canary scheduler. Existing Commerce/production units unchanged."""
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import uuid

spec = importlib.util.spec_from_file_location("transport", Path(__file__).with_name("scheduled-backup.py"))
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
ROOT = Path("/root/flexperiment-platform-canary")
LOCAL = Path("/var/backups/flexperiment-platform-v2")
APP = "ks8c2wmlle1kvdfuwbiwthe1"
REMOTE = "cloud:art-backups/flexperiment/platform-v2/canary/sqlite"


def require(condition):
    if not condition:
        raise ValueError("PLATFORM_SCHEDULED_BACKUP_REFUSED")


def private_directory(directory):
    require(not directory.is_symlink() and directory.is_dir()
            and directory.stat().st_uid == 0 and directory.stat().st_mode & 0o777 == 0o700)


def inspect(config):
    require(set(config) == {"sourceCommit", "recipient"}
            and re.fullmatch(r"[a-f0-9]{40}", config["sourceCommit"])
            and re.fullmatch(r"age1[0-9a-z]{58}", config["recipient"]))
    containers = [n for n in transport.run(["docker", "ps", "--format", "{{.Names}}"]).decode().splitlines()
                  if re.fullmatch(APP + r"-\d{8}T\d{6}", n)]
    require(len(containers) == 1)
    name = containers[0]
    data = json.loads(transport.run(["docker", "inspect", name]))[0]
    env = dict(value.split("=", 1) for value in data["Config"]["Env"])
    expected = {
        "PLATFORM_V2_CANARY": "true", "DEPLOY_ENV": "staging", "PAYLOAD_JOBS_ENABLED": "false",
        "PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false",
        "PAYLOAD_DATABASE_URL": "file:/var/lib/flexperiment-platform-canary/platform.sqlite",
        "BUILD_IDENTITY_FILE": "/app/.identity/identity.json", "SOURCE_COMMIT": config["sourceCommit"],
        "PLATFORM_BACKUP_AGE_RECIPIENT": config["recipient"],
    }
    require(all(env.get(k) == v for k, v in expected.items()) and data["HostConfig"]["PortBindings"] in ({}, None))
    sources = []
    for suffix, destination in [("editorial", "/var/lib/flexperiment-platform-canary"),
                                ("backups", "/var/lib/flexperiment-platform-canary-backups")]:
        mounts = [v for v in data["Mounts"] if v["Destination"] == destination]
        require(len(mounts) == 1 and mounts[0]["RW"] and mounts[0]["Type"] == "volume"
                and mounts[0]["Name"] == APP + "-flexperiment-platform-v2-canary-" + suffix)
        sources.append(mounts[0]["Source"])
    require(len(set(sources)) == 2)
    identity = json.loads(transport.run(["docker", "exec", name, "cat", "/app/.identity/identity.json"]))
    require(identity == {"schema": "flexperiment.build-identity/1", "service": "platform", "sourceCommit": config["sourceCommit"]})
    return name


def backup(config, now):
    container = inspect(config)
    for key in ["s3-access-key", "s3-secret-key"]:
        transport.private(transport.CONF / key)
    proof = json.loads(transport.run(["docker", "exec", container, "python3", "/app/scripts/v2/platform-backup.py"]))
    require(proof.get("service") == "platform" and proof.get("environment") == "canary"
            and proof.get("sourceCommit") == config["sourceCommit"]
            and re.fullmatch(r"platform-canary-" + config["sourceCommit"] + r"-[a-f0-9-]{36}\.sqlite\.age", proof.get("filename", ""))
            and isinstance(proof.get("size"), int) and proof["size"] > 0
            and re.fullmatch(r"[a-f0-9]{64}", proof.get("sha256", "")))
    directory = LOCAL / "canary"
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    private_directory(directory)
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"platform-canary-{stamp}-{config['sourceCommit']}-{uuid.uuid4()}.sqlite.age"
    archive = directory / filename
    require(not archive.exists())
    transport.run(["docker", "cp", f"{container}:/var/lib/flexperiment-platform-canary-backups/{proof['filename']}", str(archive)])
    archive.chmod(0o600)
    require(archive.stat().st_size == proof["size"] and transport.digest(archive) == proof["sha256"])
    with archive.open("rb") as handle:
        os.fsync(handle.fileno())
    fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    transport.s3(directory, f'rclone copyto "/backup/{filename}" "{REMOTE}/{filename}"')
    readback = transport.s3(directory, f'rclone cat "{REMOTE}/{filename}" | sha256sum').decode().split()
    require(len(readback) == 2 and readback[0] == proof["sha256"])
    # Retain the current proven object even if the host clock moves backwards.
    remote_names = transport.s3(directory, f'rclone lsf --files-only "{REMOTE}"').decode().splitlines()
    for old in transport.names("platform-canary", remote_names, 100, filename):
        transport.s3(directory, f'rclone deletefile "{REMOTE}/{old}"')
    for old in transport.names("platform-canary", [p.name for p in directory.iterdir() if p.is_file() and not p.is_symlink()], 7, filename):
        (directory / old).unlink()
    # Leave app-produced ciphertext intact; never delete source/qualified volumes.
    return {"target": "canary", "service": "platform", "status": "SUCCESS", "verifiedAt": now,
            "filename": filename, "sourceCommit": config["sourceCommit"], "sha256": proof["sha256"], "size": proof["size"]}


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 2 and sys.argv[1] in ("backup", "check"))
    os.umask(0o077)
    transport.LOCAL = LOCAL  # Separate module instance; existing Commerce services are untouched.
    config_path = ROOT / "backup-config.json"
    transport.private(config_path)
    config = json.loads(config_path.read_text())
    directory = LOCAL / "canary"
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    with (directory / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sys.argv[1] == "check":
            result = transport.check("canary", now)
            state = json.loads(transport.state_path("canary").read_text())
            require(state.get("service") == "platform" and state.get("sourceCommit") == config["sourceCommit"])
        else:
            previous = None
            if transport.state_path("canary").exists():
                transport.private(transport.state_path("canary"))
                state = json.loads(transport.state_path("canary").read_text())
                previous = state if state.get("status") == "SUCCESS" else state.get("lastSuccess")
            transport.write_state("canary", {"target": "canary", "status": "IN_PROGRESS", "attemptedAt": now, "lastSuccess": previous})
            try:
                result = backup(config, now)
                transport.write_state("canary", result)
            except Exception:
                transport.write_state("canary", {"target": "canary", "status": "FAILED", "attemptedAt": now, "lastSuccess": previous})
                raise
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("PLATFORM_SCHEDULED_BACKUP_STOP", file=sys.stderr)
        raise SystemExit(1) from None
