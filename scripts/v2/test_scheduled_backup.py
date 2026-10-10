#!/usr/bin/env python3
"""No owner secrets or live cloud/database access. Optional real pinned rclone."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("scheduled_backup", pathlib.Path(__file__).with_name("scheduled-backup.py"))
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
SHA = "a" * 40
TOKEN = "00112233-4455-6677-8899-aabbccddeeff"
NOW = 1791640000
APPS = {"canary": "c" * 24, "production": "p" * 24}
RECIPIENT = "age1" + "q" * 58


def metadata(target):
    return [{"Config": {"Env": [
        f"COMMERCE_V2_ENVIRONMENT={target}", "COMMERCE_V2_DATABASE_PATH=/var/lib/flexperiment-v2/commerce.sqlite",
        "COMMERCE_V2_BACKUP_PATH=/var/lib/flexperiment-v2-backups", "BUILD_IDENTITY_FILE=/app/.identity/identity.json",
        f"COMMERCE_V2_BACKUP_AGE_RECIPIENT={RECIPIENT}", "UNRELATED_SECRET=never-output-me"]},
        "Mounts": [{"Destination": path, "Source": "/isolated/" + target + "/" + str(index), "RW": True}
                   for index, path in enumerate(("/var/lib/flexperiment-v2", "/var/lib/flexperiment-v2-backups"))]}]


class BackupContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.conf = self.root / "conf"
        self.conf.mkdir()
        (self.conf / "age-recipient.txt").write_text(RECIPIENT)
        (self.root / "deploy-config.json").write_text(json.dumps({"apps": APPS}))
        for key in ("s3-access-key", "s3-secret-key"):
            (self.conf / key).write_text("fixture-only")
        for name, value in (("ROOT", self.root), ("CONF", self.conf), ("LOCAL", self.root / "backups")):
            item = patch.object(backup, name, value)
            item.start()
            self.addCleanup(item.stop)

    def fake_runtime(self, args):
        if args[1] == "ps":
            return (APPS["canary"] + "-20261010T120000\n").encode()
        return json.dumps(metadata("canary")).encode()

    def test_actual_app_scope_and_metadata(self):
        with patch.object(backup, "run", side_effect=self.fake_runtime):
            self.assertTrue(backup.inspect("canary", {"apps": APPS}).startswith(APPS["canary"]))

    def test_wrong_or_shared_app_identity_refuses_before_docker(self):
        for apps in ({"canary": APPS["canary"]}, {"canary": APPS["canary"], "production": APPS["canary"]},
                     {**APPS, "extra": "x" * 24}, {**APPS, "canary": "commerce-v1"}):
            with self.subTest(apps=apps), patch.object(backup, "run") as run, self.assertRaises(ValueError):
                backup.inspect("canary", {"apps": apps})
            run.assert_not_called()

    def test_zero_or_multiple_runtime_refuses(self):
        for found in (b"", (APPS["canary"] + "-20261010T120000\n" + APPS["canary"] + "-20261010T130000").encode()):
            with self.subTest(found=found), patch.object(backup, "run", return_value=found), self.assertRaisesRegex(ValueError, "RUNTIME_NOT_UNIQUE"):
                backup.inspect("canary", {"apps": APPS})

    def test_wrong_environment_path_recipient_or_mount_refuses(self):
        for mutation in ("env", "path", "recipient", "shared", "missing", "readonly"):
            data = metadata("canary")
            if mutation == "env":
                data[0]["Config"]["Env"][0] = "COMMERCE_V2_ENVIRONMENT=production"
            elif mutation == "path":
                data[0]["Config"]["Env"][1] = "COMMERCE_V2_DATABASE_PATH=/legacy.sqlite"
            elif mutation == "recipient":
                data[0]["Config"]["Env"][4] = "COMMERCE_V2_BACKUP_AGE_RECIPIENT=age1" + "a" * 58
            elif mutation == "shared":
                data[0]["Mounts"][1]["Source"] = data[0]["Mounts"][0]["Source"]
            elif mutation == "missing":
                data[0]["Mounts"].pop()
            else:
                data[0]["Mounts"][0]["RW"] = False
            with self.subTest(mutation=mutation), patch.object(backup, "run", side_effect=[self.fake_runtime(["docker", "ps"]), json.dumps(data).encode()]), self.assertRaises(ValueError):
                backup.inspect("canary", {"apps": APPS})

    def test_exact_name_retention_is_per_environment(self):
        values = [f"canary-20260101T{hour:02}0000Z-{SHA}-{TOKEN}.sqlite.age" for hour in range(12)]
        foreign = [f"production-20260101T000000-{SHA}-{TOKEN}.sqlite.age", "README", "../escape", "canary-old.sqlite.age"]
        self.assertEqual(backup.names("canary", values + foreign, 7), sorted(values, reverse=True)[7:])

    def test_clock_correction_never_prunes_current_verified_archive(self):
        current = f"canary-20250101T000000Z-{SHA}-{TOKEN}.sqlite.age"
        future = [f"canary-20260101T{hour:02}0000Z-{SHA}-{TOKEN}.sqlite.age" for hour in range(12)]
        discarded = backup.names("canary", future + [current], 7, current)
        self.assertNotIn(current, discarded)
        self.assertEqual(len(discarded), 6)
        with self.assertRaisesRegex(ValueError, "VERIFIED_ARCHIVE_NOT_LISTED"):
            backup.names("canary", future, 7, current)

    def test_failed_and_expired_status_refuses(self):
        for data in ({"status": "FAILED"}, {"status": "IN_PROGRESS"}, {"status": "SUCCESS", "verifiedAt": NOW - backup.MAX_AGE - 1},
                     {"status": "SUCCESS", "verifiedAt": NOW + 1}, {"status": "SUCCESS", "verifiedAt": "never"}):
            backup.write_state("canary", {"target": "canary", "sha256": "f" * 64, **data})
            with self.subTest(data=data), patch.object(backup, "private"), self.assertRaises(ValueError):
                backup.check("canary", NOW)

    def test_success_status_atomic_private_and_fresh(self):
        backup.write_state("canary", {"target": "canary", "status": "SUCCESS", "verifiedAt": NOW, "sha256": "f" * 64})
        self.assertEqual(backup.state_path("canary").stat().st_mode & 0o777, 0o600)
        with patch.object(backup, "private"):
            self.assertEqual(backup.check("canary", NOW)["status"], "FRESH")

    def test_secret_file_permissions_and_symlink_refuse(self):
        key = self.root / "key"
        key.write_text("test-only")
        key.chmod(0o644)
        with self.assertRaises(ValueError):
            backup.private(key)
        symlink = self.root / "link"
        symlink.symlink_to(key)
        with self.assertRaises(ValueError):
            backup.private(symlink)

    def simulate(self, target="canary", remote_hash=None, upload_fails=False):
        encrypted = b"age-encryption.org/v1\nfixture-ciphertext"
        import hashlib
        sha = hashlib.sha256(encrypted).hexdigest()
        proof = {"filename": f"{target}-{SHA}-{TOKEN}.sqlite.age", "size": len(encrypted), "sha256": sha}
        def run(args):
            if args[1] == "cp":
                pathlib.Path(args[-1]).write_bytes(encrypted)
                return b""
            if args[1] == "exec" and "backup-cli.ts" in args[-1]:
                return json.dumps(proof).encode()
            return b""
        def s3(directory, command):
            if upload_fails:
                raise ValueError("COMMAND_FAILED")
            if "rclone cat" in command:
                return f"{remote_hash or sha}  -\n".encode()
            if "rclone lsf" in command:
                return "\n".join(item.name for item in directory.glob("*.sqlite.age")).encode()
            return b""
        with patch.object(backup, "private"), patch.object(backup, "inspect", return_value="test-container"), \
                patch.object(backup, "run", side_effect=run) as runtime, patch.object(backup, "s3", side_effect=s3) as remote:
            result = backup.backup(target, NOW)
        return result, runtime, remote

    def test_upload_readback_precedes_retention_and_success(self):
        result, runtime, remote = self.simulate()
        self.assertEqual(result["status"], "SUCCESS")
        commands = [call.args[1] for call in remote.call_args_list]
        self.assertIn("rclone copyto", commands[0])
        self.assertIn("rclone cat", commands[1])
        self.assertIn("rclone lsf", commands[2])
        self.assertTrue(all("/canary/sqlite" in command for command in commands))
        self.assertNotIn("never-output-me", json.dumps(result))
        self.assertNotIn("migrate", str(runtime.call_args_list))

    def test_remote_mismatch_never_prunes_or_publishes_success(self):
        with self.assertRaisesRegex(ValueError, "REMOTE_HASH_DIFFERS"):
            self.simulate(remote_hash="0" * 64)
        self.assertFalse(backup.state_path("canary").exists())
        self.assertEqual(len(list((backup.LOCAL / "canary").glob("*.sqlite.age"))), 1)

    def test_remote_hash_rule_removal_is_caught_by_named_regression(self):
        real_require = backup.require
        def mutation(value, reason):
            if reason != "REMOTE_HASH_DIFFERS":
                real_require(value, reason)
        # Run the actual regression against the causal mutation, not a string assertion.
        result = unittest.TestResult()
        with patch.object(backup, "require", side_effect=mutation):
            BackupContract("test_remote_mismatch_never_prunes_or_publishes_success").run(result)
        self.assertEqual(len(result.failures), 1)
        self.assertEqual(len(result.errors), 0)

    def test_namespace_rule_removal_is_caught_by_named_regression(self):
        def mutation(target, values, keep):
            return sorted([value for value in values if value.endswith(".sqlite.age")], reverse=True)[keep:]
        result = unittest.TestResult()
        with patch.object(backup, "names", side_effect=mutation):
            BackupContract("test_exact_name_retention_is_per_environment").run(result)
        self.assertEqual(len(result.failures), 1)
        self.assertEqual(len(result.errors), 0)

    def test_failed_upload_retains_local_ciphertext(self):
        with self.assertRaisesRegex(ValueError, "COMMAND_FAILED"):
            self.simulate(upload_fails=True)
        self.assertFalse(backup.state_path("canary").exists())
        self.assertEqual(len(list((backup.LOCAL / "canary").glob("*.sqlite.age"))), 1)

    def test_s3_arguments_never_contain_secret_values(self):
        with patch.object(backup, "run", return_value=b"") as run:
            backup.s3(self.root, "rclone lsf cloud:art-backups/flexperiment/commerce-v2/canary/sqlite")
        args = run.call_args.args[0]
        self.assertNotIn("fixture-only", str(args))
        self.assertIn("set -o pipefail", args[-1])
        self.assertIn("/secrets/s3-secret-key", args[-1])
        self.assertIn(backup.S3_IMAGE, args)

    def test_transport_exceptions_are_sanitized(self):
        with patch.object(subprocess, "run", side_effect=OSError("private-token-and-body")), self.assertRaisesRegex(ValueError, "^COMMAND_FAILED$"):
            backup.run(["docker", "ps"])

    def test_fixed_main_failure_records_failed_state(self):
        with patch.object(sys, "argv", ["scheduled-backup.py", "canary", "backup"]), \
                patch.object(os, "geteuid", return_value=0), patch.object(backup, "backup", side_effect=ValueError("SECRET")), self.assertRaises(ValueError):
            backup.main()
        self.assertEqual(json.loads(backup.state_path("canary").read_text())["status"], "FAILED")
        self.assertNotIn("SECRET", backup.state_path("canary").read_text())

    def test_crash_cannot_reuse_preceding_success(self):
        old = {"target": "canary", "status": "SUCCESS", "verifiedAt": NOW, "sha256": "f" * 64}
        backup.write_state("canary", old)
        with patch.object(sys, "argv", ["scheduled-backup.py", "canary", "backup"]), \
                patch.object(os, "geteuid", return_value=0), patch.object(backup, "private"), \
                patch.object(backup, "backup", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            backup.main()
        interrupted = json.loads(backup.state_path("canary").read_text())
        self.assertEqual(interrupted["status"], "IN_PROGRESS")
        self.assertEqual(interrupted["lastSuccess"], old)
        with patch.object(backup, "private"), self.assertRaises(ValueError):
            backup.check("canary", NOW)

    def test_template_schedule_and_ci_wiring(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        service = (root / "deploy/host/flexperiment-commerce-v2-backup@.service").read_text()
        timer = (root / "deploy/host/flexperiment-commerce-v2-backup@.timer").read_text()
        self.assertIn("scheduled-backup.py %i backup", service)
        self.assertIn("UMask=0077", service)
        self.assertIn("OnUnitActiveSec=6h", timer)
        self.assertIn("@%i.service", timer)
        self.assertIn("scripts/v2/test_scheduled_backup.py", (root / ".github/workflows/test.yml").read_text())

    @unittest.skipUnless(os.environ.get("V2_BACKUP_REAL_S3_CLIENT") == "1", "enable in CI for real pinned rclone")
    def test_real_pinned_rclone_copy_readback_and_delete(self):
        repo = pathlib.Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix=".v2-backup-contract-", dir=repo) as temporary:
            directory = pathlib.Path(temporary)
            remote = directory / "remote"
            remote.mkdir()
            (directory / "ciphertext.age").write_bytes(b"fixture-encrypted-by-TS-test")
            def client(command):
                return backup.run(["docker", "run", "--rm", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                                   "-v", f"{directory}:/backup:ro", "-v", f"{remote}:/remote",
                                   "--entrypoint", "/bin/sh", backup.S3_IMAGE, "-c",
                                   "set -eu; set -o pipefail; export RCLONE_CONFIG_CLOUD_TYPE=alias RCLONE_CONFIG_CLOUD_REMOTE=/remote; " + command])
            client("rclone copyto /backup/ciphertext.age cloud:canary/ciphertext.age")
            self.assertEqual(client("rclone cat cloud:canary/ciphertext.age | sha256sum").decode().split()[0], backup.digest(directory / "ciphertext.age"))
            with self.assertRaises(ValueError):
                client("rclone cat cloud:canary/absent.age | sha256sum")
            client("rclone deletefile cloud:canary/ciphertext.age")
            self.assertFalse((remote / "canary/ciphertext.age").exists())


if __name__ == "__main__":
    unittest.main()
