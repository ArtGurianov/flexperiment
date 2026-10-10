#!/usr/bin/env python3
"""Offline owner boundary tests. No SSH, live API, database or credentials."""
import importlib.util
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("owner_rpc", pathlib.Path(__file__).with_name("owner-rpc.py"))
rpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rpc)
CANARY, PRODUCTION = "c" * 24, "p" * 24
CONFIG = {"apps": {"canary": CANARY, "production": PRODUCTION}}
SHA = "a" * 40


class OwnerControl(unittest.TestCase):
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

    def test_restart_refuses_public_or_wrong_app(self):
        for current in [{"fqdn": "https://commerce.flexperiment.ru", "name": "flexperiment-commerce-v2-canary", "dockerfile_location": "/Dockerfile.commerce-v2"},
                        {"fqdn": None, "name": "commerce", "dockerfile_location": "/Dockerfile.commerce"}]:
            with patch.object(rpc, "api", return_value=current) as api, self.assertRaises(ValueError):
                rpc.handle({"operation": "restart", "target": "canary"}, CONFIG)
            self.assertEqual(api.call_count, 1)
            self.assertEqual(api.call_args.args[0], "GET")

    def test_safe_app_metadata_contains_no_environment_or_secret(self):
        value = {"uuid": CANARY, "environment_variables": "secret", "token": "secret", "settings": {"is_auto_deploy_enabled": False, "secret": "secret"}}
        self.assertNotIn("secret", json.dumps(rpc.app_safe(value)))

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
