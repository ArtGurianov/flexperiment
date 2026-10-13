#!/usr/bin/env python3
"""Offline, no network and no Docker: ART-337 admission transition contract."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

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
    files = {}
    for name, value in (("inventory", inventory), ("qualification", qualification), ("restore", restore), ("boot", boot)):
        path = root / (name + ".json")
        raw = json.dumps(value).encode()
        path.write_bytes(raw)
        files[name] = {"path": str(path), "sha256": q.digest(raw)}
    return files


class Requalification(unittest.TestCase):
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
                        "dockerfile_location": "/Dockerfile.commerce-v2", "settings": {"is_auto_deploy_enabled": False}}
            @staticmethod
            def env_value(row):
                return row["value"]
            @staticmethod
            def exclusive_canary(_uuid):
                return {"exclusive": True}
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
                patch.object(q, "current_fence", return_value=(state, 0, 0)) as fence:
            self.assertEqual(q.verify_live(manifest, RPC), old)
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
            def local_lstat(path):
                info = real_lstat(path)
                if pathlib.Path(path) == root / "erasure-admission-history":
                    return type("LocalStat", (), {"st_mode": info.st_mode, "st_uid": 0})()
                return info
            with patch.object(q, "ROOT", root), patch.object(q, "PREDECESSOR_SHA256", old_hash), \
                    patch.object(q, "private_bytes", side_effect=lambda path, *_args, **_kw: pathlib.Path(path).read_bytes()), \
                    patch.object(q.os, "lstat", side_effect=local_lstat):
                current = q.publish(manifest, old)
                journal = json.loads((root / "erasure-admission.json").read_bytes())
                self.assertEqual(journal["version"], 2)
                self.assertEqual(journal["sourceCommit"], q.TARGET)
                self.assertEqual(journal["previousJournalSha256"], old_hash)
                self.assertEqual(q.digest((root / "erasure-admission.json").read_bytes()), current)
                history = root / "erasure-admission-history"
                self.assertEqual((history / (old_hash + ".json")).read_bytes(), old)
                for key in q.REQUIRED_FILES:
                    sha = files[key]["sha256"]
                    self.assertEqual(q.digest((history / (sha + "-" + key + ".json")).read_bytes()), sha)

    def test_history_conflict_refuses_before_active_journal_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            old = b"old"; old_hash = q.digest(old)
            (root / "erasure-admission.json").write_bytes(old)
            history = root / "erasure-admission-history"; history.mkdir(mode=0o700)
            (history / (old_hash + ".json")).write_bytes(b"foreign")
            real_lstat = q.os.lstat
            def local_lstat(path):
                info = real_lstat(path)
                if pathlib.Path(path) == history:
                    return type("LocalStat", (), {"st_mode": info.st_mode, "st_uid": 0})()
                return info
            with patch.object(q, "ROOT", root), patch.object(q, "PREDECESSOR_SHA256", old_hash), \
                    patch.object(q, "private_bytes", side_effect=lambda path, *_args, **_kw: pathlib.Path(path).read_bytes()), \
                    patch.object(q.os, "lstat", side_effect=local_lstat), \
                    self.assertRaisesRegex(ValueError, "HISTORY_CONFLICT"):
                q.publish({"files": {}}, old)
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
