#!/usr/bin/env python3
"""ART-329: consistent, redacted inventory of the two canary SQLite authorities.

The source databases are opened with mode=ro and query_only. The only writes
are new, private snapshot/report files under the caller's archive directory.
No row values, identifiers, email addresses, or secrets are emitted.
"""

from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
from datetime import datetime, timezone


GROUPS = {
    "commerce": {
        "identity": {"schema_identity", "schema_migrations", "launch_seed"},
        "auth_and_customers": {"user", "session", "account", "verification", "customers", "auth_email_outbox"},
        "orders_and_payments": {"checkout_quotes", "orders", "order_lines", "checkout_attempts"},
        "refunds": {"refund_requests", "refund_decisions", "refund_executions", "course_access_starts"},
        "access": {"course_entitlements", "free_course_enrollments", "access_overrides", "course_commercial_commands"},
        "campaigns_and_consents": {"marketing_consents", "account_consents", "authenticated_consent_actions", "authenticated_consent_events", "email_suppressions", "notification_campaigns", "notification_campaign_recipients"},
        "catalogue": {"products", "offers", "merchant_promotion", "fiscal_policy_versions", "sales_activation", "cities", "lab_occurrences", "legal_releases"},
        "course_manifest": {"catalog_course_projection", "catalog_section_projection", "catalog_lesson_projection"},
        "media_and_playback": {"lesson_video_bindings", "video_upload_sessions", "kinescope_webhook_events", "lesson_resume_positions", "playback_grant_rate_limits", "playback_access_events"},
        "operations": {"control_room_admin_sessions", "control_room_login_rate_limits", "control_room_audit_log", "audit_log", "deployment_durability"},
    },
    "payload": {
        "identity": {"payload_migrations", "payload_kv"},
        "users_and_sessions": {"users", "users_sessions"},
        "courses": {"courses", "_courses_v", "course_manifest_states"},
        "sections": {"sections", "_sections_v"},
        "lessons": {"lessons", "_lessons_v"},
        "media": {"media"},
        "access_operations": {"access_operations"},
        "jobs": {"payload_jobs", "payload_jobs_log", "payload_jobs_stats"},
        "editorial_auxiliary": {"payload_locked_documents", "payload_locked_documents_rels", "payload_preferences", "payload_preferences_rels", "search", "search_rels"},
    },
}

PENDING_STATES = {
    "commerce": {
        "access_overrides": ("state", {"PENDING"}),
        "refund_executions": ("state", {"PROCESSING"}),
        "video_upload_sessions": ("status", {"UPLOADING", "PROCESSING"}),
    },
    "payload": {
        "access_operations": ("state", {"COMMITTED_UNACKED"}),
        "payload_jobs": ("processing", {"1"}),
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_stat(path: Path) -> dict:
    info = path.stat()
    return {
        "path": str(path.resolve(strict=True)),
        "device": info.st_dev,
        "inode": info.st_ino,
        "size": info.st_size,
        "mtime_ns": info.st_mtime_ns,
        "mode": oct(stat.S_IMODE(info.st_mode)),
    }


def read_db(path: Path, *, immutable: bool = False) -> sqlite3.Connection:
    suffix = "?mode=ro&immutable=1" if immutable else "?mode=ro"
    db = sqlite3.connect(path.as_uri() + suffix, uri=True, timeout=30)
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA busy_timeout=30000")
    return db


def snapshot(source: Path, target: Path) -> dict:
    if target.exists():
        raise FileExistsError(target)
    before = source_stat(source)
    with closing(read_db(source)) as live:
        with closing(sqlite3.connect(target)) as copy:
            live.backup(copy, pages=128, sleep=0.1)
    after = source_stat(source)
    with closing(read_db(target, immutable=True)) as check:
        integrity = check.execute("PRAGMA integrity_check").fetchone()[0]
    if integrity != "ok":
        raise RuntimeError("SNAPSHOT_INTEGRITY_FAILED")
    os.chmod(target, 0o400)
    return {
        "source_before": before,
        "source_after": after,
        "snapshot_path": str(target),
        "snapshot_size": target.stat().st_size,
        "snapshot_sha256": sha256(target),
        "integrity_check": integrity,
        "captured_at_utc": utc_now(),
    }


def table_names(db: sqlite3.Connection) -> list[str]:
    return [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE ? ORDER BY name",
        ("table", "sqlite_%"),
    )]


def quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def inventory(path: Path, kind: str) -> dict:
    with closing(read_db(path, immutable=True)) as db:
        names = table_names(db)
        if kind == "commerce":
            lineage = db.execute("SELECT lineage FROM schema_identity").fetchone()
            if lineage != ("flexperiment-v2",):
                raise RuntimeError("COMMERCE_LINEAGE_MISMATCH")
        else:
            if "payload_migrations" not in names or "courses" not in names:
                raise RuntimeError("PAYLOAD_SCHEMA_MISMATCH")
        membership = {table: group for group, tables in GROUPS[kind].items() for table in tables}
        missing = sorted(set(membership) - set(names))
        rows = []
        for table in names:
            count = db.execute(f"SELECT COUNT(*) FROM {quoted(table)}").fetchone()[0]
            group = membership.get(table, "unmapped")
            classification = (
                "empty" if count == 0 else
                "immutable_evidence" if group == "identity" else
                "owner_review_required"
            )
            item = {"table": table, "group": group, "count": count, "classification": classification}
            pending = PENDING_STATES[kind].get(table)
            if pending:
                column, states = pending
                columns = {row[1] for row in db.execute(f"PRAGMA table_info({quoted(table)})")}
                if column in columns:
                    placeholders = ",".join("?" for _ in states)
                    item["pending_count"] = db.execute(
                        f"SELECT COUNT(*) FROM {quoted(table)} WHERE CAST({quoted(column)} AS TEXT) IN ({placeholders})",
                        tuple(sorted(states)),
                    ).fetchone()[0]
                else:
                    item["pending_count"] = None
                    item["schema_gap"] = f"expected column {column} missing"
            rows.append(item)
        nonempty = [item for item in rows if item["count"] and item["classification"] == "owner_review_required"]
        unmapped = [item for item in rows if item["count"] and item["group"] == "unmapped"]
        return {
            "kind": kind,
            "snapshot_sha256": sha256(path),
            "tables": rows,
            "nonempty_owner_review_tables": len(nonempty),
            "nonempty_unmapped_tables": len(unmapped),
            "missing_expected_tables": missing,
            "decision": "STOP_REVIEW_REQUIRED" if nonempty or unmapped or missing else "OWNER_REVIEW_PENDING",
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commerce", type=Path, required=True)
    parser.add_argument("--payload", type=Path, required=True)
    parser.add_argument("--archive-dir", type=Path, required=True)
    parser.add_argument("--commerce-instance", required=True)
    parser.add_argument("--payload-instance", required=True)
    args = parser.parse_args()
    archive = args.archive_dir.resolve()
    if archive.exists():
        raise FileExistsError(f"archive already exists: {archive}")
    if any(archive == path.resolve() or archive in path.resolve().parents for path in (args.commerce, args.payload)):
        raise ValueError("archive overlaps a source database")
    archive.mkdir(mode=0o700, parents=True)
    records = {}
    for kind, source in (("commerce", args.commerce), ("payload", args.payload)):
        target = archive / f"{kind}.sqlite"
        records[kind] = snapshot(source, target)
        records[kind]["instance"] = getattr(args, f"{kind}_instance")
    report = {
        "issue": "ART-329",
        "environment": "canary-v2",
        "generated_at_utc": utc_now(),
        "snapshots": records,
        "inventories": {kind: inventory(archive / f"{kind}.sqlite", kind) for kind in ("commerce", "payload")},
        "decision": "STOP_REVIEW_REQUIRED",
        "decision_reason": "Every nonempty data table requires owner classification; counts alone cannot establish zero real data.",
    }
    report_path = archive / "inventory.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    os.chmod(report_path, 0o400)
    print(json.dumps({
        "archive": str(archive),
        "report_sha256": sha256(report_path),
        "snapshot_sha256": {kind: records[kind]["snapshot_sha256"] for kind in records},
        "decision": report["decision"],
        "counts": {kind: {item["table"]: item["count"] for item in report["inventories"][kind]["tables"]} for kind in records},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
