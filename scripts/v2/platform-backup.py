#!/usr/bin/env python3
"""Editorial-only online snapshot. No migrations, network or recovery private key."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import uuid


def require(condition):
    if not condition:
        raise ValueError("PLATFORM_BACKUP_REFUSED")


def digest(filename):
    result = hashlib.sha256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def snapshot(source, directory, identity, recipient):
    require(identity.get("schema") == "flexperiment.build-identity/1"
            and identity.get("service") == "platform"
            and re.fullmatch(r"[a-f0-9]{40}", identity.get("sourceCommit", ""))
            and re.fullmatch(r"age1[0-9a-z]{58}", recipient)
            and source.is_file() and not source.is_symlink()
            and not directory.is_symlink() and source.parent.resolve() != directory.resolve())
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    archive = directory / f"platform-canary-{identity['sourceCommit']}-{uuid.uuid4()}.sqlite.age"
    os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix=".editorial-", dir=directory) as temporary:
            plain = Path(temporary) / "platform.sqlite"
            with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
                db.execute("PRAGMA query_only=ON")
                tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                require({"payload_migrations", "users", "courses", "lessons"} <= tables
                        and not ({"schema_identity", "orders", "checkout_attempts"} & tables))
                require(db.execute("SELECT COUNT(*) FROM payload_migrations").fetchone()[0] > 0)
                deadline = time.monotonic() + 30

                def progress(_status, _remaining, _total):
                    require(time.monotonic() < deadline)

                with sqlite3.connect(plain) as target:
                    db.backup(target, pages=256, progress=progress, sleep=0.05)
                    require(target.execute("PRAGMA integrity_check").fetchone()[0] == "ok")
            subprocess.run(["age", "-r", recipient, "-o", str(archive), str(plain)],
                           check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        archive.chmod(0o600)
        require(archive.stat().st_size > 0)
        with archive.open("rb") as stream:
            os.fsync(stream.fileno())
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return {"service": "platform", "environment": "canary", "sourceCommit": identity["sourceCommit"],
                "filename": archive.name, "sha256": digest(archive), "size": archive.stat().st_size}
    except Exception:
        archive.unlink(missing_ok=True)
        raise ValueError("PLATFORM_BACKUP_REFUSED") from None


def main():
    require(os.environ.get("PLATFORM_V2_CANARY") == "true"
            and os.environ.get("PAYLOAD_DATABASE_URL") == "file:/var/lib/flexperiment-platform-canary/platform.sqlite"
            and os.environ.get("BUILD_IDENTITY_FILE") == "/app/.identity/identity.json")
    identity = json.loads(Path("/app/.identity/identity.json").read_text())
    return snapshot(Path("/var/lib/flexperiment-platform-canary/platform.sqlite"),
                    Path("/var/lib/flexperiment-platform-canary-backups"), identity,
                    os.environ.get("PLATFORM_BACKUP_AGE_RECIPIENT", ""))


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except Exception:
        print("PLATFORM_BACKUP_REFUSED", file=__import__("sys").stderr)
        raise SystemExit(1) from None
