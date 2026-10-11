import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("platform_backup", Path(__file__).with_name("platform-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class EditorialBackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "data" / "platform.sqlite"
        self.source.parent.mkdir()
        self.directory = self.root / "backups"
        self.identity = {"schema": "flexperiment.build-identity/1", "service": "platform", "sourceCommit": "a" * 40}
        self.key = self.root / "recovery.key"
        subprocess.run(["age-keygen", "-o", str(self.key)], check=True, capture_output=True)
        self.recipient = subprocess.check_output(["age-keygen", "-y", str(self.key)], text=True).strip()
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA journal_mode=WAL")
        for table in ("users", "courses", "lessons", "payload_migrations"):
            self.db.execute(f"CREATE TABLE {table}(id INTEGER PRIMARY KEY, name TEXT)")
        self.db.execute("INSERT INTO payload_migrations VALUES(1,'synthetic-migration')")
        self.db.commit()

    def test_real_encryption_independent_restore_includes_committed_wal(self):
        self.db.execute("INSERT INTO courses VALUES(1,'synthetic-private-content')")
        self.db.commit()
        # Keep source open so WAL is still live; copying main DB alone loses this row.
        require_wal = Path(str(self.source) + "-wal")
        self.assertGreater(require_wal.stat().st_size, 0)
        proof = backup.snapshot(self.source, self.directory, self.identity, self.recipient)
        archive = self.directory / proof["filename"]
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(backup.digest(archive), proof["sha256"])
        self.assertNotIn(b"synthetic-private-content", archive.read_bytes())
        restored = self.root / "restored.sqlite"
        subprocess.run(["age", "-d", "-i", str(self.key), "-o", str(restored), str(archive)], check=True)
        with sqlite3.connect(restored) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            for table in ("users", "courses", "lessons", "payload_migrations"):
                self.assertEqual(db.execute(f"SELECT * FROM {table}").fetchall(), self.db.execute(f"SELECT * FROM {table}").fetchall())
        self.assertEqual(list(self.directory.glob(".editorial-*")), [])

    def test_foreign_service_refused(self):
        with self.assertRaises(ValueError):
            backup.snapshot(self.source, self.directory, {**self.identity, "service": "commerce-v2"}, self.recipient)

    def test_commerce_schema_refused(self):
        self.db.execute("CREATE TABLE orders(id TEXT)")
        self.db.commit()
        with self.assertRaises(ValueError):
            backup.snapshot(self.source, self.directory, self.identity, self.recipient)

    def test_missing_source_not_created(self):
        absent = self.root / "absent.sqlite"
        with self.assertRaises(ValueError):
            backup.snapshot(absent, self.directory, self.identity, self.recipient)
        self.assertFalse(absent.exists())

    def test_encryption_failure_removes_plaintext_and_partial_ciphertext(self):
        with patch.object(backup.subprocess, "run", side_effect=RuntimeError("secret reflected failure")):
            with self.assertRaisesRegex(ValueError, "^PLATFORM_BACKUP_REFUSED$"):
                backup.snapshot(self.source, self.directory, self.identity, self.recipient)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_symlink_and_shared_directory_refused(self):
        linked = self.root / "link.sqlite"
        linked.symlink_to(self.source)
        for source, directory in ((linked, self.directory), (self.source, self.source.parent)):
            with self.assertRaises(ValueError):
                backup.snapshot(source, directory, self.identity, self.recipient)

    def test_entrypoint_refuses_default_environment_without_logs(self):
        with patch.dict(backup.os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                backup.main()


if __name__ == "__main__":
    unittest.main()
