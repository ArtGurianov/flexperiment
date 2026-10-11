"""Synthetic isolated contracts. No VPS, owner secrets or cloud writes."""
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("editorial_scheduler", Path(__file__).with_name("platform-scheduled-backup.py"))
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)
SHA = "a" * 40
CONFIG = {"sourceCommit": SHA, "recipient": "age1" + "q" * 58}
NAME = scheduler.APP + "-20261011T000000"


def metadata():
    env = {"PLATFORM_V2_CANARY": "true", "DEPLOY_ENV": "staging", "PAYLOAD_JOBS_ENABLED": "false",
           "PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false", "SOURCE_COMMIT": SHA,
           "PLATFORM_BACKUP_AGE_RECIPIENT": CONFIG["recipient"], "BUILD_IDENTITY_FILE": "/app/.identity/identity.json",
           "PAYLOAD_DATABASE_URL": "file:/var/lib/flexperiment-platform-canary/platform.sqlite"}
    return [{"Config": {"Env": [k + "=" + v for k, v in env.items()]}, "HostConfig": {"PortBindings": {}},
             "Mounts": [{"Destination": "/var/lib/flexperiment-platform-canary" + ("-backups" if suffix == "backups" else ""),
                         "Name": scheduler.APP + "-flexperiment-platform-v2-canary-" + suffix,
                         "Source": "/isolated/" + suffix, "Type": "volume", "RW": True} for suffix in ["editorial", "backups"]]}]


def runtime(data=None):
    return [NAME.encode(), json.dumps(data or metadata()).encode(), json.dumps({"schema": "flexperiment.build-identity/1", "service": "platform", "sourceCommit": SHA}).encode()]


class PlatformScheduler(unittest.TestCase):
    def test_exact_canary_identity_and_separate_mounts(self):
        with patch.object(scheduler.transport, "run", side_effect=runtime()):
            self.assertEqual(scheduler.inspect(CONFIG), NAME)

    def test_zero_multiple_and_foreign_container_refuse(self):
        for names in [b"", (NAME + "\n" + NAME + "0").encode(), b"production-platform-20261011T000000"]:
            with patch.object(scheduler.transport, "run", return_value=names), self.assertRaises(ValueError):
                scheduler.inspect(CONFIG)

    def test_config_must_be_bound_without_extra_secret_or_app_fields(self):
        for config in [{**CONFIG, "app": "production"}, {**CONFIG, "sourceCommit": "main"}, {**CONFIG, "recipient": "private-key"}, {}]:
            with patch.object(scheduler.transport, "run") as run, self.assertRaises(ValueError):
                scheduler.inspect(config)
            run.assert_not_called()

    def test_unsafe_runtime_conditions_refuse(self):
        for mutation in ["payments", "jobs", "source", "recipient", "environment", "host_port", "shared", "foreign_volume"]:
            data = metadata()
            fields = {"payments": "PAYMENT_MODE", "jobs": "PAYLOAD_JOBS_ENABLED", "source": "SOURCE_COMMIT", "recipient": "PLATFORM_BACKUP_AGE_RECIPIENT", "environment": "DEPLOY_ENV"}
            if mutation in fields:
                key = fields[mutation]
                data[0]["Config"]["Env"] = [key + "=unsafe" if row.startswith(key + "=") else row for row in data[0]["Config"]["Env"]]
            elif mutation == "host_port":
                data[0]["HostConfig"]["PortBindings"] = {"3001/tcp": [{"HostPort": "3001"}]}
            elif mutation == "shared":
                data[0]["Mounts"][1]["Source"] = data[0]["Mounts"][0]["Source"]
            else:
                data[0]["Mounts"][0]["Name"] = "commerce-data"
            with self.subTest(mutation=mutation), patch.object(scheduler.transport, "run", side_effect=runtime(data)), self.assertRaises(ValueError):
                scheduler.inspect(CONFIG)

    def test_baked_identity_mismatch_refuses(self):
        answers = runtime();answers[-1] = json.dumps({"schema": "flexperiment.build-identity/1", "service": "platform", "sourceCommit": "b" * 40}).encode()
        with patch.object(scheduler.transport, "run", side_effect=answers), self.assertRaises(ValueError):
            scheduler.inspect(CONFIG)

    def simulate(self, remote_hash=None, upload_failure=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = b"age-encryption.org/v1\nisolated-fixture"
            digest = hashlib.sha256(data).hexdigest()
            proof = {"service": "platform", "environment": "canary", "sourceCommit": SHA, "filename": f"platform-canary-{SHA}-00112233-4455-6677-8899-aabbccddeeff.sqlite.age", "size": len(data), "sha256": digest}
            def run(args):
                if args[1] == "cp":
                    Path(args[-1]).write_bytes(data);return b""
                return json.dumps(proof).encode()
            commands = []
            def s3(directory, command):
                commands.append(command)
                if "copyto" in command and upload_failure:
                    raise ValueError("isolated failure")
                if "sha256sum" in command:
                    return ((remote_hash or digest) + "  -").encode()
                if "lsf" in command:
                    return (next((root / "canary").glob("platform-canary-*.age")).name + "\n").encode()
                return b""
            with patch.object(scheduler, "LOCAL", root), patch.object(scheduler, "inspect", return_value=NAME), patch.object(scheduler, "private_directory"), patch.object(scheduler.transport, "private"), patch.object(scheduler.transport, "run", side_effect=run), patch.object(scheduler.transport, "s3", side_effect=s3):
                result = scheduler.backup(CONFIG, 1791640000)
            self.assertEqual(result["sha256"], digest)
            self.assertEqual(result["service"], "platform")
            self.assertTrue(all("flexperiment/platform-v2/canary/sqlite" in c for c in commands))
            self.assertFalse(any("commerce-v2" in c or "production" in c or "deletefile" in c for c in commands))
            self.assertEqual(next((root / "canary").glob("*.age")).stat().st_mode & 0o777, 0o600)

    def test_ciphertext_root_staging_and_independent_remote_hash(self):
        self.simulate()

    def test_wrong_remote_hash_or_upload_failure_never_passes(self):
        for opts in [{"remote_hash": "b" * 64}, {"upload_failure": True}]:
            with self.subTest(opts=opts), self.assertRaises(ValueError):
                self.simulate(**opts)

    def test_retention_cannot_select_foreign_or_current_archive(self):
        current = f"platform-canary-20250101T000000Z-{SHA}-00112233-4455-6677-8899-aabbccddeeff.sqlite.age"
        names = [current] + [f"platform-canary-20260101T{i:02}0000Z-{SHA}-00112233-4455-6677-8899-aabbccddeeff.sqlite.age" for i in range(12)]
        names += ["production.sqlite.age", "../escape", "canary-old.age"]
        chosen = scheduler.transport.names("platform-canary", names, 7, current)
        self.assertNotIn(current, chosen);self.assertEqual(len(chosen), 6)
        self.assertTrue(all(n.startswith("platform-canary-") for n in chosen))

    def test_units_are_platform_only_and_timer_six_hourly(self):
        directory = Path(__file__).resolve().parents[2] / "deploy/v2"
        service = (directory / "platform-canary-backup.service").read_text()
        timer = (directory / "platform-canary-backup.timer").read_text()
        self.assertIn("platform-scheduled-backup.py backup", service)
        self.assertIn("UMask=0077", service)
        self.assertNotIn("production", service)
        self.assertIn("00,06,12,18:23:00 UTC", timer)
        self.assertIn("Persistent=true", timer)

    def test_attempt_failure_is_durable_and_never_inherits_success(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(scheduler, "ROOT", Path(temp)), patch.object(scheduler, "LOCAL", Path(temp)/"archives"), patch.object(scheduler.transport, "LOCAL", Path(temp)/"archives"), patch.object(scheduler.transport, "private"), patch.object(scheduler.os, "geteuid", return_value=0), patch.object(sys, "argv", ["scheduler", "backup"]), patch.object(scheduler, "backup", side_effect=ValueError("isolated failure")):
            (Path(temp)/"backup-config.json").write_text(json.dumps(CONFIG))
            scheduler.transport.write_state("canary", {"target": "canary", "service": "platform", "status": "SUCCESS", "verifiedAt": 1, "sha256": "f"*64})
            with self.assertRaises(ValueError):
                scheduler.main()
            state=json.loads(scheduler.transport.state_path("canary").read_text())
            self.assertEqual(state["status"], "FAILED")
            self.assertEqual(state["lastSuccess"]["status"], "SUCCESS")
            with self.assertRaises(ValueError):
                scheduler.transport.check("canary", state["attemptedAt"])

    def test_causal_hash_validation_regression_is_detected(self):
        result=unittest.TestResult()
        with patch.object(scheduler, "require", return_value=None):
            PlatformScheduler("test_wrong_remote_hash_or_upload_failure_never_passes").run(result)
        self.assertFalse(result.wasSuccessful())
        self.assertTrue(result.failures)


if __name__ == "__main__":
    unittest.main()
