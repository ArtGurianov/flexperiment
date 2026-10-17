#!/usr/bin/env python3
"""Offline, no network and no Docker: ART-337 admission transition contract."""
import importlib.util
import json
import pathlib
import contextlib
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("art337", pathlib.Path(__file__).with_name("art337_erasure_requalification.py"))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def report_files(root, sequence=1):
    inventory = {"issue": "ART-329", "environment": "canary-v2", "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                 "snapshots": {kind: {"integrity_check": "ok", "snapshot_sha256": "a" * 64} for kind in ("commerce", "payload")},
                 "inventories": {kind: {"tables": [{"table": table, "count": count} for table, count in baseline.items()]}
                                 for kind, baseline in q.APPROVED_NONZERO.items()}}
    proofs = [{"kind": kind, "migrationCount": count, "beforeUsers": users, "appliedSequence": sequence,
               "erasedAccounts": users, "integrity": "ok", "foreignKeys": "ok"}
              for kind, count, users in (("synthetic25", 25, 1), ("synthetic26", 26, 1), ("current26", 26, 0))]
    restore = {"target": q.TARGET, "result": "PASS", "proofs": proofs}
    qualification = {"sourceCommit": q.TARGET, "freshCommerceSnapshotSha256": "a" * 64, "result": restore,
                     "recordedAt": datetime.now(timezone.utc).isoformat(), "imageId": "sha256:" + "d" * 64,
                     "proofScriptSha256": q.digest(pathlib.Path(q.__file__).with_name("art337-proof-restores.mjs").read_bytes()),
                     "bootScriptSha256": q.digest(pathlib.Path(q.__file__).with_name("art337-proof-boot.mjs").read_bytes())}
    boot = {"target": q.TARGET, "result": "BOOT_PASS", "fence": "OPEN", "leases": 0,
            "erasure": "qualified", "integrity": "ok", "foreignKeys": "ok", "afterMigrations": 26}
    backup = {"version": 1, "scope": "canary", "sourceCommit": q.PREDECESSOR, "state": "READBACK_PASS",
              "previousChainReadback": "PASS", "recoveryKeys": "AVAILABLE", "archives": {},
              "recordedAt": datetime.now(timezone.utc).isoformat(),
              "previousChainObjects": [{"object": "synthetic/old.sqlite.age", "sha256": "c" * 64,
                                        "remoteSha256": "c" * 64, "size": 100}]}
    for kind in ("commerce", "payload"):
        path = root / (kind + ".sqlite.age")
        raw = ("synthetic-ciphertext-" + kind).encode(); path.write_bytes(raw)
        backup["archives"][kind] = {"path": str(path), "sha256": q.digest(raw), "remoteSha256": q.digest(raw),
                                    "size": len(raw), "snapshotSha256": "a" * 64}
    files = {}
    for name, value in (("inventory", inventory), ("qualification", qualification), ("restore", restore), ("boot", boot), ("backup", backup)):
        path = root / (name + ".json")
        raw = json.dumps(value).encode()
        path.write_bytes(raw)
        files[name] = {"path": str(path), "sha256": q.digest(raw)}
    return files


@contextlib.contextmanager
def isolated_publish():
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        old = b'{"sourceCommit":"' + q.PREDECESSOR.encode() + b'"}\n'
        old_hash = q.digest(old)
        files = report_files(root)
        manifest = {"files": files, "ledgerSequence": 1, "mirrorSha256": "c" * 64,
                    "imageId": "sha256:" + "d" * 64, "qualifiedAt": "2026-10-13T13:00:00+00:00",
                    "ownerDecision": "ZERO_REAL_DATA_CONFIRMED_WITH_CLASSIFIED_SYNTHETIC_EVENT"}
        (root / "erasure-admission.json").write_bytes(old)
        real_lstat = q.os.lstat
        def local_lstat(path, **kwargs):
            info = real_lstat(path, **kwargs)
            if pathlib.Path(path) == root / "erasure-admission-history":
                return type("LocalStat", (), {"st_mode": info.st_mode, "st_uid": 0})()
            return info
        with patch.object(q, "ROOT", root), patch.object(q, "PREDECESSOR_SHA256", old_hash), \
                patch.object(q, "private_bytes", side_effect=lambda path, *_args, **_kw: pathlib.Path(path).read_bytes()), \
                patch.object(q.os, "lstat", side_effect=local_lstat):
            yield root, manifest, old


class OnlineBackupCompatibility(unittest.TestCase):
    def test_snapshot_includes_committed_wal_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source_path = root / "commerce.sqlite"
            writer = sqlite3.connect(source_path)
            try:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
                writer.commit()
                writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                writer.execute("INSERT INTO example VALUES (1)")
                writer.commit()
                wal = pathlib.Path(str(source_path) + "-wal")
                self.assertGreater(wal.stat().st_size, 0)
                # Main-file copying would omit the committed row in the WAL.
                main_copy = root / "main-only.sqlite"
                main_copy.write_bytes(source_path.read_bytes())
                with contextlib.closing(sqlite3.connect(main_copy)) as main:
                    self.assertEqual(main.execute("SELECT COUNT(*) FROM example").fetchone(), (0,))
                expected_path = root / "expected.sqlite"
                reader = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)
                output = sqlite3.connect(expected_path)
                try:
                    reader.backup(output)
                    self.assertEqual(output.execute("SELECT id FROM example").fetchall(), [(1,)])
                finally:
                    output.close(); reader.close()
                before = (source_path.read_bytes(), wal.read_bytes())
                with patch.object(q, "ROOT", root):
                    self.assertEqual(q.online_backup_sha256(source_path, True), q.digest(expected_path.read_bytes()))
                self.assertEqual((source_path.read_bytes(), wal.read_bytes()), before)
                self.assertEqual(list(root.glob("art337-live-*")), [])
            finally:
                writer.close()

    def test_busy_source_refuses_without_retry_or_source_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source_path = root / "commerce.sqlite"
            writer = sqlite3.connect(source_path, timeout=0)
            try:
                writer.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
                writer.commit()
                writer.execute("BEGIN EXCLUSIVE")
                writer.execute("INSERT INTO example VALUES (1)")
                # The real SQLite backup callback reports BUSY for this lock.
                with patch.object(q, "ROOT", root), patch.object(q.time, "monotonic", side_effect=[0, 11]) as clock, \
                        self.assertRaisesRegex(q.Refusal, "LIVE_SNAPSHOT_BUSY_OR_TIMEOUT"):
                    q.online_backup_sha256(source_path, True)
                # BUSY aborts immediately, before any deadline check or retry.
                self.assertEqual(clock.call_count, 1)
                self.assertEqual(list(root.glob("art337-live-*")), [])
                writer.rollback()
                self.assertEqual(writer.execute("SELECT COUNT(*) FROM example").fetchone(), (0,))
            finally:
                writer.close()

    def test_locked_callback_refuses_without_retry(self):
        # Inject the SQLite LOCKED callback, not sqlite3 module constants.
        # Ordinary separate-connection lock contention reports BUSY instead.
        actual_connect = sqlite3.connect
        calls = []
        class LockedSource(sqlite3.Connection):
            def backup(self, destination, *, progress, **kwargs):
                calls.append("backup")
                progress(6, 0, 0)
                raise AssertionError("LOCKED callback must abort backup")
        def connect(database, **kwargs):
            if kwargs.get("uri"):
                kwargs["factory"] = LockedSource
            return actual_connect(database, **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source_path = root / "commerce.sqlite"
            db = actual_connect(source_path)
            db.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
            db.commit(); db.close()
            before = source_path.read_bytes()
            with patch.object(q, "ROOT", root), patch.object(q.sqlite3, "connect", side_effect=connect), \
                    patch.object(q.time, "monotonic", side_effect=[0, 11]) as clock, \
                    self.assertRaisesRegex(q.Refusal, "LIVE_SNAPSHOT_BUSY_OR_TIMEOUT"):
                q.online_backup_sha256(source_path, True)
            self.assertEqual(clock.call_count, 1)
            self.assertEqual(calls, ["backup"])
            self.assertEqual(source_path.read_bytes(), before)
            self.assertEqual(list(root.glob("art337-live-*")), [])

    def test_real_backup_refuses_after_monotonic_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source_path = root / "commerce.sqlite"
            db = sqlite3.connect(source_path)
            db.execute("CREATE TABLE example(value BLOB)")
            db.execute("INSERT INTO example VALUES (zeroblob(1048576))")
            db.commit(); db.close()
            before = source_path.read_bytes()
            # Only time is controlled: Connection.backup and its callback are real.
            with patch.object(q, "ROOT", root), patch.object(q.time, "monotonic", side_effect=[0, 11]), \
                    self.assertRaisesRegex(q.Refusal, "LIVE_SNAPSHOT_BUSY_OR_TIMEOUT"):
                q.online_backup_sha256(source_path, True)
            self.assertEqual(source_path.read_bytes(), before)
            self.assertEqual(list(root.glob("art337-live-*")), [])


class Requalification(unittest.TestCase):
    def test_payload_writer_requires_stopped_app_disabled_timer_and_no_volume_writer(self):
        token = "synthetic-service-token-" + "a" * 32
        class RPC:
            @staticmethod
            def api(_method, path):
                if path.endswith("/envs"):
                    if q.PLATFORM_APP not in path:
                        return [{"key": "PLATFORM_SERVICE_TOKEN", "value": token, "is_runtime": True}]
                    return [{"key": "PAYLOAD_JOBS_ENABLED", "value": "false", "is_runtime": True},
                            {"key": "PLATFORM_COMMERCE_SERVICE_TOKEN", "value": token, "is_runtime": True}]
                return {"uuid": q.PLATFORM_APP, "name": "flexperiment-platform-v2-canary",
                        "git_repository": "ArtGurianov/flexperiment", "git_commit_sha": q.PLATFORM_SOURCE,
                        "status": "stopped", "settings": {"is_auto_deploy_enabled": False}}
            @staticmethod
            def env_value(row): return row["value"]
            @staticmethod
            def container(_uuid, _optional): return None
            @staticmethod
            def private_json(_path): return {"apps": {"canary": "c" * 24}}
        def systemctl(args, **_kw):
            return Mock(stdout="disabled\n" if args[1] == "is-enabled" else "inactive\n")
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(q.subprocess, "run", side_effect=systemctl), \
                    patch.object(q, "volume_directory", return_value=pathlib.Path(directory).resolve()), \
                    patch.object(q, "command", return_value=""), patch.object(q, "no_writable_fd") as fds, \
                    patch.object(q, "no_service_token_process"):
                q.verify_payload_stopped(RPC)
                fds.assert_called_once()
                with patch.object(RPC, "container", return_value="still-running"), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_RUNTIME_ACTIVE_OR_UNKNOWN"):
                    q.verify_payload_stopped(RPC)
                with patch.object(q.subprocess, "run", side_effect=lambda args, **kw: Mock(stdout="active\n")
                                  if args[1] == "is-active" else systemctl(args, **kw)), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_JOB_ACTIVE_OR_UNKNOWN"):
                    q.verify_payload_stopped(RPC)
                with patch.object(q.subprocess, "run", side_effect=lambda args, **kw: Mock(stdout="enabled\n")
                                  if args[1] == "is-enabled" else systemctl(args, **kw)), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_TIMER_ENABLED"):
                    q.verify_payload_stopped(RPC)
                with patch.object(q, "command", side_effect=lambda args: "other-platform-canary-worker.service loaded inactive dead\n"
                                  if args[:2] == ["systemctl", "list-units"] else ""), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_UNKNOWN_JOB_UNIT"):
                    q.verify_payload_stopped(RPC)
                with patch.object(q, "command", side_effect=lambda args: "running-id" if args[:3] == ["docker", "ps", "-q"]
                                  else json.dumps([{"Mounts": [{"RW": True, "Source": directory}]}])), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_COMPETING_MOUNT"):
                    q.verify_payload_stopped(RPC)
                with patch.object(q, "command", side_effect=lambda args: "running-id" if args[:3] == ["docker", "ps", "-q"]
                                  else json.dumps([{"Mounts": [], "Config": {"Env": ["ANY_TOKEN=" + token]}}])), \
                        self.assertRaisesRegex(ValueError, "PAYLOAD_SERVICE_TOKEN_CONTAINER_ACTIVE"):
                    q.verify_payload_stopped(RPC)

    def test_payload_service_token_host_process_is_refused_without_logging_values(self):
        from unittest.mock import mock_open
        token = "synthetic-service-token-" + "b" * 32
        with patch.object(q.os, "listdir", return_value=["123"]), \
                patch("builtins.open", mock_open(read_data=("TOKEN=" + token).encode())), \
                self.assertRaisesRegex(ValueError, "PAYLOAD_SERVICE_TOKEN_PROCESS_ACTIVE"):
            q.no_service_token_process(token)
        with patch.object(q.os, "listdir", return_value=["123"]), patch("builtins.open", mock_open(read_data=b"unrelated=other")):
            q.no_service_token_process(token)

    def test_live_qualification_refuses_writer_ledger_and_fence_drift(self):
        old = json.dumps({"sourceCommit": q.PREDECESSOR, "recovery": "PASS",
                          "installationId": q.INSTALLATION, "readerBindingSha256": q.READER_BINDING}).encode()
        bundle = {"scope": "canary", "entries": [{"hash": "head"}]}
        manifest = {"ledgerSequence": 1, "mirrorSha256": "b" * 64, "imageId": "sha256:" + "d" * 64}
        class RPC:
            @staticmethod
            def private_json(_path):
                return {"apps": {"canary": "c" * 24, "production": "p" * 24}}
            @staticmethod
            def erasure_environment(_uuid):
                return None
            @staticmethod
            def api(_method, path):
                if path.endswith("/envs"):
                    return [{"key": "SOURCE_COMMIT", "value": q.PREDECESSOR, "is_literal": True,
                             "is_preview": False, "is_runtime": True}]
                return {"uuid": "c" * 24, "name": "flexperiment-commerce-v2-canary",
                        "git_commit_sha": q.PREDECESSOR, "git_repository": "ArtGurianov/flexperiment",
                        "dockerfile_location": "/Dockerfile.commerce-v2", "status": "stopped",
                        "settings": {"is_auto_deploy_enabled": False}}
            @staticmethod
            def env_value(row):
                return row["value"]
            @staticmethod
            def exclusive_canary(_uuid):
                return {"exclusive": True}
            @staticmethod
            def container(_uuid, _optional):
                return None
        def read_json(path, **_kwargs):
            if str(path).endswith("installation.json"):
                return {"scope": "canary", "state": "REQUIRED", "installationId": q.INSTALLATION,
                        "readerBindingSha256": q.READER_BINDING}, "a" * 64
            return bundle, "b" * 64
        def run(args):
            if args[0].endswith("flexperiment-erasure"):
                return json.dumps({"state": "REMOTE_VERIFIED", "scope": "canary", "sequence": 1})
            if args[:3] == ["docker", "image", "inspect"]:
                return json.dumps([{"Id": manifest["imageId"]}])
            return json.dumps({"schema": "flexperiment.build-identity/1", "service": "commerce-v2", "sourceCommit": q.TARGET})
        state = ("canary", "CLOSED", 1, "head", None)
        with patch.object(q, "PREDECESSOR_SHA256", q.digest(old)), patch.object(q, "private_bytes", return_value=old), \
                patch.object(q, "json_file", side_effect=read_json), patch.object(q, "command", side_effect=run), \
                patch.object(q, "current_fence", return_value=(state, 0, 0)) as fence, \
                patch.object(q, "verify_payload_stopped"), patch.object(q, "verify_live_payload_snapshot"), \
                patch.object(q, "verify_live_commerce_snapshot"):
            self.assertEqual(q.verify_live(manifest, RPC), old)
            with patch.object(RPC, "exclusive_canary", side_effect=AssertionError("locked path called census")):
                self.assertEqual(q.verify_live(manifest, RPC, locked=True), old)
            original_api = RPC.api
            with patch.object(RPC, "api", side_effect=lambda method, path: {**original_api(method, path),
                    "git_commit_sha": q.TARGET} if not path.endswith("/envs") else original_api(method, path)), \
                    self.assertRaisesRegex(ValueError, "PREDECESSOR_APP_IDENTITY_DRIFT"):
                q.verify_live(manifest, RPC)
            with patch.object(RPC, "exclusive_canary", return_value={"pending": True}), \
                    self.assertRaisesRegex(ValueError, "COMPETING_WRITER_OR_RUNTIME"):
                q.verify_live(manifest, RPC)
            with patch.object(q, "command", side_effect=lambda args: json.dumps({"state": "REMOTE_VERIFIED", "scope": "canary", "sequence": 2})
                              if args[0].endswith("flexperiment-erasure") else run(args)), \
                    self.assertRaisesRegex(ValueError, "REMOTE_LEDGER_DRIFT"):
                q.verify_live(manifest, RPC)
            fence.return_value = (state, 1, 1)
            with self.assertRaisesRegex(ValueError, "FENCE_NOT_DRAINED"):
                q.verify_live(manifest, RPC)

    def test_reports_bind_exact_snapshot_target_three_restore_cases_and_boot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            manifest = {"files": report_files(root), "ledgerSequence": 1, "schemaFingerprints": q.SCHEMAS,
                        "imageId": "sha256:" + "d" * 64,
                        "ownerDecision": "ZERO_REAL_DATA_CONFIRMED_WITH_CLASSIFIED_SYNTHETIC_EVENT"}
            with patch.object(q, "private_bytes", side_effect=lambda path, *_args, **_kw: pathlib.Path(path).read_bytes()):
                self.assertEqual(q.verify_reports(manifest)["result"]["result"], "PASS")
                for key, field, value, error in (("inventory", "environment", "production", "INVENTORY_INVALID"),
                                                 ("backup", "state", "HOLD", "BACKUP_READBACK_INVALID"),
                                                 ("boot", "fence", "CLOSED", "BOOT_PROOF_INVALID"),
                                                 ("restore", "target", "b" * 40, "RESTORE_PROOF_INVALID")):
                    path = pathlib.Path(manifest["files"][key]["path"])
                    original = path.read_bytes()
                    altered = json.loads(original); altered[field] = value
                    raw = json.dumps(altered).encode(); path.write_bytes(raw)
                    manifest["files"][key]["sha256"] = q.digest(raw)
                    with self.assertRaisesRegex(ValueError, error):
                        q.verify_reports(manifest)
                    path.write_bytes(original); manifest["files"][key]["sha256"] = q.digest(original)
                manifest["files"]["boot"]["sha256"] = "b" * 64
                with self.assertRaisesRegex(ValueError, "EVIDENCE_DIGEST_MISMATCH"):
                    q.verify_reports(manifest)
                manifest["files"]["boot"]["sha256"] = q.digest(pathlib.Path(manifest["files"]["boot"]["path"]).read_bytes())
                inventory_path = pathlib.Path(manifest["files"]["inventory"]["path"])
                shifted = json.loads(inventory_path.read_bytes())
                shifted["inventories"]["commerce"]["tables"].append({"table": "orders", "count": 1})
                raw = json.dumps(shifted).encode(); inventory_path.write_bytes(raw)
                manifest["files"]["inventory"]["sha256"] = q.digest(raw)
                with self.assertRaisesRegex(ValueError, "INVENTORY_SCOPE_DRIFT"):
                    q.verify_reports(manifest)

    def test_commit_archives_predecessor_and_evidence_then_reads_back(self):
        with isolated_publish() as (root, manifest, old):
            current = q.publish(manifest, old)
            journal = json.loads((root / "erasure-admission.json").read_bytes())
            self.assertEqual(journal["version"], 2)
            self.assertEqual(journal["sourceCommit"], q.TARGET)
            self.assertEqual(journal["previousJournalSha256"], q.digest(old))
            self.assertEqual(q.digest((root / "erasure-admission.json").read_bytes()), current)
            history = root / "erasure-admission-history"
            self.assertEqual((history / (q.digest(old) + ".json")).read_bytes(), old)
            for key in q.REQUIRED_FILES:
                sha = manifest["files"][key]["sha256"]
                self.assertEqual(q.digest((history / (sha + "-" + key + ".json")).read_bytes()), sha)
            with self.assertRaisesRegex(ValueError, "ALREADY_PUBLISHED_REQUIRES_REVIEW"):
                q.publish(manifest, old)

    def test_replace_failure_preserves_pending_and_refuses_automatic_retry(self):
        with isolated_publish() as (root, manifest, old):
            with patch.object(q.os, "replace", side_effect=OSError("injected replace failure")), \
                    self.assertRaises(OSError):
                q.publish(manifest, old)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertEqual((root / "erasure-admission.json.requalification-pending").read_bytes(), q.journal_candidate(manifest))
            self.assertEqual(q.inspect_publication(manifest)["reason"], "UNPUBLISHED_REQUIRES_REVIEW")
            self.assertTrue((root / "erasure-admission.json.requalification-pending").exists())
            with self.assertRaisesRegex(ValueError, "PENDING_RECORD_UNKNOWN"):
                q.publish(manifest, old)

    def test_foreign_pending_refuses_before_creating_history_and_is_preserved(self):
        with isolated_publish() as (root, manifest, old):
            pending = root / "erasure-admission.json.requalification-pending"
            pending.write_bytes(b"unknown-result")
            with self.assertRaisesRegex(ValueError, "PENDING_RECORD_UNKNOWN"):
                q.publish(manifest, old)
            with self.assertRaisesRegex(ValueError, "PENDING_RECORD_UNKNOWN"):
                q.inspect_publication(manifest)
            self.assertEqual(pending.read_bytes(), b"unknown-result")
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertFalse((root / "erasure-admission-history").exists())

    def test_fsync_failure_preserves_first_history_file_and_refuses_retry(self):
        with isolated_publish() as (root, manifest, old):
            with patch.object(q.os, "fsync", side_effect=OSError("injected fsync failure")), \
                    self.assertRaises(OSError):
                q.publish(manifest, old)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertEqual((root / "erasure-admission-history" / (q.digest(old) + ".json")).read_bytes(), old)
            self.assertEqual(q.inspect_publication(manifest)["reason"], "UNPUBLISHED_REQUIRES_REVIEW")
            with self.assertRaisesRegex(ValueError, "HISTORY_ALREADY_PRESENT_REQUIRES_REVIEW"):
                q.publish(manifest, old)

    def test_pending_fsync_failure_keeps_candidate_and_old_journal(self):
        with isolated_publish() as (root, manifest, old):
            actual_fsync = q.os.fsync
            pending = root / "erasure-admission.json.requalification-pending"
            def fail_pending_fsync(fd):
                if pending.exists():
                    raise OSError("injected pending fsync failure")
                return actual_fsync(fd)
            with patch.object(q.os, "fsync", side_effect=fail_pending_fsync), self.assertRaises(OSError):
                q.publish(manifest, old)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertEqual(pending.read_bytes(), q.journal_candidate(manifest))
            self.assertEqual(q.inspect_publication(manifest)["reason"], "UNPUBLISHED_REQUIRES_REVIEW")
            with self.assertRaisesRegex(ValueError, "PENDING_RECORD_UNKNOWN"):
                q.publish(manifest, old)

    def test_replace_commits_then_raises_preserves_new_journal_for_review(self):
        with isolated_publish() as (root, manifest, old):
            actual_replace = q.os.replace
            def uncertain_replace(source, destination):
                actual_replace(source, destination)
                raise OSError("injected lost replace response")
            with patch.object(q.os, "replace", side_effect=uncertain_replace), self.assertRaises(OSError):
                q.publish(manifest, old)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), q.journal_candidate(manifest))
            self.assertEqual(q.inspect_publication(manifest)["reason"], "ALREADY_PUBLISHED_REQUIRES_REVIEW")
            with self.assertRaisesRegex(ValueError, "ALREADY_PUBLISHED_REQUIRES_REVIEW"):
                q.publish(manifest, old)

    def test_post_replace_fsync_failure_retains_published_evidence_for_retry(self):
        with isolated_publish() as (root, manifest, old):
            actual_sync = q.sync_directory
            def fail_after_replace(path):
                if pathlib.Path(path) == root and (root / "erasure-admission.json").read_bytes() != old:
                    raise OSError("injected directory fsync failure")
                return actual_sync(path)
            with patch.object(q, "sync_directory", side_effect=fail_after_replace), self.assertRaises(OSError):
                q.publish(manifest, old)
            candidate = q.journal_candidate(manifest)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), candidate)
            self.assertFalse((root / "erasure-admission.json.requalification-pending").exists())
            with self.assertRaisesRegex(ValueError, "ALREADY_PUBLISHED_REQUIRES_REVIEW"):
                q.publish(manifest, old)

    def test_exclusive_snapshot_rejects_row_added_after_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            db_path = root / "commerce.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO example VALUES (1)")
            db.commit(); db.close()
            snapshot = root / "inventory.sqlite"
            source = sqlite3.connect(db_path); output = sqlite3.connect(snapshot)
            source.backup(output); source.close(); output.close()
            expected = q.digest(snapshot.read_bytes())
            db_info = db_path.stat()
            identity = {"path": str(db_path), "device": db_info.st_dev, "inode": db_info.st_ino}
            report = {"snapshots": {"commerce": {"source_before": identity,
                                                  "source_after": identity,
                                                  "snapshot_sha256": expected}}}
            class RPC:
                @staticmethod
                def private_json(_path): return {"apps": {"canary": "c" * 24}}
                @staticmethod
                def api(_method, _path): return {"persistent_storages": [{"name": "c" * 24 + "-data",
                    "mount_path": "/var/lib/flexperiment-v2"}]}
                @staticmethod
                def exclusive_canary(_uuid): return {"exclusive": True}
            with patch.object(q, "ROOT", root), patch.object(q, "volume_directory", return_value=root), \
                    patch.object(q, "checked_report", return_value=report):
                self.assertEqual(q.verify_live_commerce_snapshot({}, RPC), expected)
                db = sqlite3.connect(db_path); db.execute("INSERT INTO example VALUES (2)"); db.commit(); db.close()
                with self.assertRaisesRegex(ValueError, "LIVE_COMMERCE_INVENTORY_DRIFT"):
                    q.verify_live_commerce_snapshot({}, RPC)

    def test_customer_created_after_inventory_refuses_final_publish_and_preserves_old_journal(self):
        with isolated_publish() as (root, manifest, old):
            db_path = root / "commerce.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("CREATE TABLE customers(id TEXT PRIMARY KEY)")
            db.commit(); db.close()
            snapshot = root / "inventory.sqlite"
            source = sqlite3.connect(db_path); output = sqlite3.connect(snapshot)
            source.backup(output); source.close(); output.close()
            info = db_path.stat()
            identity = {"path": str(db_path), "device": info.st_dev, "inode": info.st_ino}
            inventory_path = pathlib.Path(manifest["files"]["inventory"]["path"])
            inventory = json.loads(inventory_path.read_bytes())
            inventory["snapshots"]["commerce"] = {"source_before": identity, "source_after": identity,
                                                   "snapshot_sha256": q.digest(snapshot.read_bytes())}
            raw = json.dumps(inventory).encode(); inventory_path.write_bytes(raw)
            manifest["files"]["inventory"]["sha256"] = q.digest(raw)
            db = sqlite3.connect(db_path)
            db.execute("INSERT INTO customers VALUES ('new-test-user')")
            db.commit(); db.close()
            class RPC:
                @staticmethod
                def private_json(_path): return {"apps": {"canary": "c" * 24}}
                @staticmethod
                def api(_method, _path): return {"persistent_storages": [{"name": "c" * 24 + "-data",
                    "mount_path": "/var/lib/flexperiment-v2"}]}
            with patch.object(q, "volume_directory", return_value=root):
                with q.merchant_write_barrier(manifest, RPC), \
                        self.assertRaisesRegex(ValueError, "LIVE_COMMERCE_INVENTORY_DRIFT"):
                    q.publish(manifest, old, lambda: q.verify_live_commerce_snapshot(manifest, RPC, locked=True))
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)
            self.assertEqual((root / "erasure-admission.json.requalification-pending").read_bytes(), q.journal_candidate(manifest))

    def test_payload_snapshot_rejects_row_added_after_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            db_path = root / "platform.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO example VALUES (1)")
            db.commit(); db.close()
            snapshot = root / "inventory.sqlite"
            source = sqlite3.connect(db_path); output = sqlite3.connect(snapshot)
            source.backup(output); source.close(); output.close()
            info = db_path.stat()
            identity = {"path": str(db_path), "device": info.st_dev, "inode": info.st_ino}
            report = {"snapshots": {"payload": {"source_before": identity, "source_after": identity,
                                                 "snapshot_sha256": q.digest(snapshot.read_bytes())}}}
            with patch.object(q, "ROOT", root), patch.object(q, "volume_directory", return_value=root), \
                    patch.object(q, "checked_report", return_value=report), patch.object(q, "no_writable_fd"):
                self.assertEqual(q.verify_live_payload_snapshot({}, object()), report["snapshots"]["payload"]["snapshot_sha256"])
                db = sqlite3.connect(db_path); db.execute("INSERT INTO example VALUES (2)"); db.commit(); db.close()
                with self.assertRaisesRegex(ValueError, "LIVE_PAYLOAD_INVENTORY_DRIFT"):
                    q.verify_live_payload_snapshot({}, object())

    def test_write_barrier_blocks_competing_writer_and_uses_second_reader_for_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            db_path = root / "commerce.sqlite"
            db = sqlite3.connect(db_path)
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE example(id INTEGER PRIMARY KEY)")
            db.execute("INSERT INTO example VALUES (1)")
            db.commit(); db.close()
            snapshot = root / "inventory.sqlite"
            source = sqlite3.connect(db_path); output = sqlite3.connect(snapshot)
            source.backup(output); source.close(); output.close()
            info = db_path.stat()
            identity = {"path": str(db_path), "device": info.st_dev, "inode": info.st_ino}
            report = {"snapshots": {"commerce": {"source_before": identity, "source_after": identity,
                                                  "snapshot_sha256": q.digest(snapshot.read_bytes())}}}
            class RPC:
                @staticmethod
                def private_json(_path): return {"apps": {"canary": "c" * 24}}
                @staticmethod
                def api(_method, _path): return {"persistent_storages": [{"name": "c" * 24 + "-data",
                    "mount_path": "/var/lib/flexperiment-v2"}]}
            with patch.object(q, "ROOT", root), patch.object(q, "volume_directory", return_value=root), \
                    patch.object(q, "checked_report", return_value=report):
                with q.merchant_write_barrier({}, RPC):
                    self.assertEqual(q.verify_live_commerce_snapshot({}, RPC, locked=True), report["snapshots"]["commerce"]["snapshot_sha256"])
                    with self.assertRaisesRegex(ValueError, "MERCHANT_WRITE_BARRIER_REFUSED"):
                        with q.merchant_write_barrier({}, RPC):
                            self.fail("competing barrier acquired")
                    competitor = sqlite3.connect(db_path, timeout=0)
                    try:
                        with self.assertRaises(sqlite3.OperationalError):
                            competitor.execute("INSERT INTO example VALUES (2)")
                    finally:
                        competitor.close()
                after = sqlite3.connect(db_path, timeout=0)
                after.execute("INSERT INTO example VALUES (2)")
                after.commit(); after.close()

    def test_history_conflict_refuses_before_active_journal_change(self):
        with isolated_publish() as (root, manifest, old):
            history = root / "erasure-admission-history"; history.mkdir(mode=0o700)
            (history / (q.digest(old) + ".json")).write_bytes(b"foreign")
            with self.assertRaisesRegex(ValueError, "HISTORY_ALREADY_PRESENT_REQUIRES_REVIEW"):
                q.publish(manifest, old)
            self.assertEqual((root / "erasure-admission.json").read_bytes(), old)

    def test_fence_refuses_unknown_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            import sqlite3
            path = pathlib.Path(directory) / "fence.sqlite"
            db = sqlite3.connect(path)
            db.executescript("CREATE TABLE fence_state(id INTEGER,scope TEXT,state TEXT,sequence INTEGER,head_hash TEXT,owner TEXT);"
                             "CREATE TABLE fence_leases(id TEXT,outcome TEXT);"
                             "INSERT INTO fence_state VALUES(1,'canary','CLOSED',1,'head',NULL);"
                             "INSERT INTO fence_leases VALUES('one','UNKNOWN');")
            db.close()
            state, leases, unknown = q.current_fence(path)
            self.assertEqual(state[1], "CLOSED")
            self.assertEqual((leases, unknown), (1, 1))


if __name__ == "__main__":
    unittest.main()
