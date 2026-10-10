#!/usr/bin/env python3
"""Offline owner boundary tests. No SSH, live API, database or credentials."""
import importlib.util
import json
import pathlib
import stat
import sys
import tempfile
import unittest
import io
import contextlib
import subprocess
import urllib.error
from unittest.mock import call, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("owner_rpc", pathlib.Path(__file__).with_name("owner-rpc.py"))
rpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rpc)
CANARY, PRODUCTION = "c" * 24, "p" * 24
CONFIG = {"apps": {"canary": CANARY, "production": PRODUCTION}}
SHA = "a" * 40


class OwnerControl(unittest.TestCase):
    def main_result(self, raw, failure=None):
        stdout = io.StringIO()
        stdin = type("Input", (), {"buffer": io.BytesIO(raw)})()
        with patch.object(rpc.sys, "stdin", stdin), patch.object(rpc, "private_json", return_value=CONFIG), \
                patch.object(rpc, "handle", side_effect=failure), contextlib.redirect_stdout(stdout):
            with self.assertRaises(SystemExit) as stopped:
                rpc.main()
        self.assertEqual(stopped.exception.code, 1)
        return json.loads(stdout.getvalue())

    def test_exception_diagnostics_are_bounded_and_preserve_failure(self):
        secret = "synthetic-secret-url-jwt-token"
        failures = [
            (ValueError(secret), "VALIDATION_REFUSED"),
            (urllib.error.HTTPError(secret, 503, secret, {}, io.BytesIO(secret.encode())), "HTTP_FAILURE"),
            (urllib.error.URLError(secret), "CONTROL_TRANSPORT_FAILED"),
            (subprocess.CalledProcessError(1, secret, output=secret, stderr=secret), "SUBPROCESS_FAILED"),
            (subprocess.TimeoutExpired(secret, 60, output=secret, stderr=secret), "SUBPROCESS_TIMEOUT"),
            (RuntimeError(secret), "OWNER_INTERNAL_ERROR"),
        ]
        for failure, reason in failures:
            with self.subTest(reason=reason):
                result = self.main_result(b'{"operation":"runtime","target":"canary"}', failure)
                self.assertEqual(result["reason"], reason)
                self.assertEqual(result["error"], "V2_OWNER_OPERATION_REFUSED")
                self.assertNotIn(secret, json.dumps(result))
                if reason == "HTTP_FAILURE":
                    self.assertEqual(result["status"], 503)
                else:
                    self.assertEqual(set(result), {"error", "reason"})

    def test_malformed_input_refuses_without_secondary_traceback(self):
        for raw in [b'not-json-secret', b'null', b'[]', b'"string-secret"', b'x' * 65537]:
            with self.subTest(raw=raw[:10]):
                self.assertEqual(self.main_result(raw), {"error": "V2_OWNER_OPERATION_REFUSED", "reason": "VALIDATION_REFUSED"})

    def test_only_nonconverged_runtime_retains_pending_semantics(self):
        stdout = io.StringIO()
        stdin = type("Input", (), {"buffer": io.BytesIO(b'{"operation":"runtime","target":"canary"}')})()
        with patch.object(rpc.sys, "stdin", stdin), patch.object(rpc, "private_json", return_value=CONFIG), \
                patch.object(rpc, "handle", side_effect=ValueError("V2_CONTAINER_NOT_CONVERGED")), contextlib.redirect_stdout(stdout):
            rpc.main()
        self.assertEqual(json.loads(stdout.getvalue()), {"pending": True})
        result = self.main_result(b'{"operation":"snapshot","target":"production"}', ValueError("V2_CONTAINER_NOT_CONVERGED"))
        self.assertEqual(result["reason"], "VALIDATION_REFUSED")

    def test_literal_secret_uses_saved_value_not_shell_quotes_and_remains_redacted(self):
        secret = "synthetic-owner-secret-32-characters"
        row = {"key": "BETTER_AUTH_SECRET", "value": secret, "real_value": "'" + secret + "'",
               "is_literal": True, "is_buildtime": False, "is_runtime": True}
        with patch.object(rpc, "api", return_value=[row]):
            result = rpc.handle({"operation": "api", "method": "GET", "path": f"/applications/{CANARY}/envs"}, CONFIG)
        self.assertEqual(result[0]["length"], len(secret))
        self.assertIsNone(result[0]["value"])
        self.assertNotIn(secret, json.dumps(result))

    def test_snapshot_binds_secret_continuity_without_export_and_ignores_mount_order(self):
        app = {"uuid": PRODUCTION, "name": "flexperiment-commerce-v2", "git_commit_sha": SHA, "settings": {}}
        env = [{"key": "NOTISEND_API_KEY", "value": "synthetic-secret-A", "is_runtime": True, "is_buildtime": False}]
        live = {"containerId": "synthetic-id", "startedAt": "fixed", "identity": {"sourceCommit": SHA},
                "baked": {"sourceCommit": SHA}, "identityMode": "444", "ready": {"foundationMode": True}, "mounts": [
                    {"destination": "/data", "name": "data"}, {"destination": "/backup", "name": "backup"}]}
        original_handle = rpc.handle
        def fake_handle(message, config):
            return live if message["operation"] == "runtime" else original_handle(message, config)
        with patch.object(rpc, "handle", side_effect=fake_handle), patch.object(rpc, "api", side_effect=lambda method, path: env if path.endswith("/envs") else app):
            first = original_handle({"operation": "snapshot", "target": "production"}, CONFIG)
            live["mounts"].reverse()
            self.assertEqual(first, original_handle({"operation": "snapshot", "target": "production"}, CONFIG))
            env[0]["value"] = "synthetic-secret-B"
            self.assertNotEqual(first, original_handle({"operation": "snapshot", "target": "production"}, CONFIG))
            live["ready"]["foundationMode"] = False
            with self.assertRaisesRegex(ValueError, "PRODUCTION_BASELINE_DIFFERS"):
                original_handle({"operation": "snapshot", "target": "production"}, CONFIG)
        self.assertEqual(set(first), {"sha256"})
        self.assertNotIn("synthetic-secret", json.dumps(first))

    def test_normal_mode_refuses_production_and_live_payment_drift_before_queue(self):
        with patch.object(rpc, "api") as api:
            with self.assertRaisesRegex(ValueError, "NORMAL_CANARY_SCOPE_REFUSED"):
                rpc.handle({"operation": "deploy", "target": "production", "mode": "normal-canary", "sha": SHA}, CONFIG)
            api.assert_not_called()
        env = [{"key": key, "value": value, "is_runtime": True} for key, value in {
            "COMMERCE_V2_FOUNDATION_MODE": "false", "PAYMENT_MODE": "refref",
            "MARKETING_BROADCASTS_ENABLED": "false", "SOURCE_COMMIT": SHA}.items()]
        with patch.object(rpc, "api", return_value=env) as api:
            with self.assertRaisesRegex(ValueError, "NORMAL_CANARY_ENVIRONMENT_DIFFERS"):
                rpc.handle({"operation": "deploy", "target": "canary", "mode": "normal-canary", "sha": SHA}, CONFIG)
            self.assertTrue(all(call.args[0] == "GET" for call in api.call_args_list))

    def test_normal_backup_is_read_only_cli_and_canary_only(self):
        with patch.object(rpc, "container", return_value="synthetic-cid"), patch.object(rpc, "run", return_value='{"sha256":"synthetic"}') as run:
            rpc.handle({"operation": "backup-runtime", "target": "canary"}, CONFIG)
            self.assertEqual(run.call_args.args[0][-1], "commerce-v2/src/backup-cli.ts")
            run.reset_mock()
            with self.assertRaisesRegex(ValueError, "NORMAL_CANARY_SCOPE_REFUSED"):
                rpc.handle({"operation": "backup-runtime", "target": "production"}, CONFIG)
            run.assert_not_called()

    def test_secret_environment_never_returns_values(self):
        secret = "never-return-this-owner-secret"
        rows = [{"key": key, "value": secret, "is_runtime": True, "is_buildtime": False}
                for key in ("PLATFORM_SERVICE_TOKEN", "NOTISEND_API_KEY", "TOCHKA_JWT", "OTHER_KEY")]
        rows.append({"key": "PAYMENT_MODE", "value": "disabled", "is_runtime": True})
        with patch.object(rpc, "api", return_value=rows):
            result = rpc.handle({"operation": "api", "method": "GET", "path": f"/applications/{CANARY}/envs"}, CONFIG)
        self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(result[0]["length"], len(secret))
        self.assertTrue(result[0]["present"])
        self.assertEqual(result[-1]["value"], "disabled")

    def test_rejects_foreign_resource_and_arbitrary_api_before_request(self):
        with patch.object(rpc, "api") as api:
            for method, path in [("GET", "/applications/" + "v" * 24), ("GET", "/servers"),
                                 ("DELETE", f"/applications/{CANARY}"),
                                 ("GET", f"/applications/{CANARY}/envs?secret=1")]:
                with self.subTest(method=method, path=path), self.assertRaises(ValueError):
                    rpc.handle({"operation": "api", "method": method, "path": path}, CONFIG)
            api.assert_not_called()

    def test_only_source_pin_and_baked_sha_are_writeable(self):
        with patch.object(rpc, "api", return_value={}) as api:
            for suffix, body in [("", {"git_commit_sha": SHA}),
                                 ("/envs", {"key": "SOURCE_COMMIT", "value": SHA, "is_buildtime": True,
                                            "is_runtime": True, "is_preview": False})]:
                self.assertEqual(rpc.handle({"operation": "api", "method": "PATCH",
                                            "path": f"/applications/{CANARY}{suffix}", "body": body}, CONFIG), {"saved": True})
            self.assertEqual(api.call_count, 2)

    def test_secret_payment_routing_and_storage_writes_refused(self):
        with patch.object(rpc, "api") as api:
            for suffix, body in [("", {"fqdn": "https://api.flexperiment.ru"}),
                                 ("", {"git_commit_sha": "main"}), ("/storages", {}),
                                 ("/envs", {"key": "PAYMENT_MODE", "value": "tochka", "is_buildtime": True,
                                            "is_runtime": True, "is_preview": False}),
                                 ("/envs", {"key": "SOURCE_COMMIT", "value": SHA, "is_buildtime": False,
                                            "is_runtime": True, "is_preview": False})]:
                with self.subTest(suffix=suffix, body=body), self.assertRaises(ValueError):
                    rpc.handle({"operation": "api", "method": "PATCH", "path": f"/applications/{CANARY}{suffix}", "body": body}, CONFIG)
            api.assert_not_called()

    def test_deploy_and_restart_refuse_public_or_wrong_app(self):
        for current in [{"fqdn": "https://commerce.flexperiment.ru", "name": "flexperiment-commerce-v2-canary", "dockerfile_location": "/Dockerfile.commerce-v2"},
                        {"fqdn": None, "name": "commerce", "dockerfile_location": "/Dockerfile.commerce"}]:
            for operation in ("deploy", "restart"):
                with self.subTest(operation=operation), patch.object(rpc, "api", return_value=current) as api, self.assertRaises(ValueError):
                    rpc.handle({"operation": operation, "target": "canary", "sha": SHA}, CONFIG)
                self.assertEqual(api.call_count, 1)
                self.assertEqual(api.call_args.args[0], "GET")

    def test_deploy_uses_post_after_isolation_check_and_records_queue(self):
        for target, uuid in CONFIG["apps"].items():
            current = {"fqdn": None, "name": "flexperiment-commerce-v2" + ("-canary" if target == "canary" else ""),
                       "dockerfile_location": "/Dockerfile.commerce-v2"}
            deployment = "synthetic-" + target
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory, \
                    patch.object(rpc, "ROOT", directory), \
                    patch.object(rpc, "api", side_effect=[current, {"deployments": [{"deployment_uuid": deployment}]}]) as api:
                result = rpc.handle({"operation": "deploy", "target": target, "sha": SHA}, CONFIG)
                self.assertEqual(api.call_args_list, [call("GET", "/applications/" + uuid),
                                                     call("POST", "/deploy?uuid=" + uuid + "&force=false")])
                self.assertEqual(result, {"deployment": deployment})
                journal = pathlib.Path(directory, "deployments", deployment + ".json")
                self.assertEqual(json.loads(journal.read_text()), {"target": target, "sha": SHA})
                self.assertEqual(stat.S_IMODE(journal.stat().st_mode), 0o600)

    def test_deploy_invalid_uuid_scope_never_calls_api(self):
        with patch.object(rpc, "api") as api:
            for target, config in [("foreign", CONFIG), ("canary", {"apps": {"canary": "../escape", "production": PRODUCTION}})]:
                with self.subTest(target=target), self.assertRaisesRegex(ValueError, "V2_TARGET_INVALID"):
                    rpc.handle({"operation": "deploy", "target": target, "sha": SHA}, config)
            api.assert_not_called()

    def test_deploy_malformed_response_id_never_records_journal(self):
        current = {"fqdn": None, "name": "flexperiment-commerce-v2-canary", "dockerfile_location": "/Dockerfile.commerce-v2"}
        with tempfile.TemporaryDirectory() as directory, patch.object(rpc, "ROOT", directory), \
                patch.object(rpc, "api", side_effect=[current, {"deployments": [{"deployment_uuid": "../../escape"}]}]):
            with self.assertRaisesRegex(ValueError, "DEPLOYMENT_ID_INVALID"):
                rpc.handle({"operation": "deploy", "target": "canary", "sha": SHA}, CONFIG)
            self.assertFalse(pathlib.Path(directory, "deployments").exists())

    def test_safe_app_metadata_contains_no_environment_or_secret(self):
        value = {"uuid": CANARY, "environment_variables": "secret", "token": "secret", "settings": {"is_auto_deploy_enabled": False, "secret": "secret"}}
        self.assertNotIn("secret", json.dumps(rpc.app_safe(value)))

    def test_override_flags_do_not_return_command_or_embedded_secrets(self):
        value = {"ports_mappings": "3002:3002", "custom_labels": "traefik-secret",
                 "custom_docker_run_options": "--env SECRET=secret", "start_command": "echo secret"}
        result = rpc.app_safe(value)
        self.assertTrue(result["portsMapped"])
        self.assertTrue(result["customRouting"])
        self.assertTrue(result["hasUnsafeOverrides"])
        self.assertNotIn("secret", json.dumps(result))

    def test_backup_filename_cannot_escape_owner_directory(self):
        with patch.object(rpc, "container", return_value="synthetic"), patch.object(rpc, "run") as run:
            for filename in ["../../escape", "production-" + SHA + "-" + "a" * 36 + ".sqlite.age", "plain.sqlite"]:
                with self.subTest(filename=filename), self.assertRaises(ValueError):
                    rpc.handle({"operation": "archive", "target": "canary", "filename": filename}, CONFIG)
            run.assert_not_called()

    def test_shared_targets_refused(self):
        with self.assertRaises(ValueError):
            rpc.handle({"operation": "config"}, {"apps": {"canary": CANARY, "production": CANARY}})

    def test_invalid_storage_command_never_executes(self):
        with patch.object(rpc, "container", return_value="synthetic"), patch.object(rpc, "run") as run, self.assertRaises(ValueError):
            rpc.handle({"operation": "storage", "target": "canary", "command": "shell"}, CONFIG)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
