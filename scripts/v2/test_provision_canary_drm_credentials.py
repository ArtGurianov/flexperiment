"""Contract tests for the owner-side canary DRM Coolify writer.

Only a stateful in-memory Coolify is used; no network or owner files are read.
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


FILE = Path(__file__).with_name("provision_canary_drm_credentials.py")
SPEC = importlib.util.spec_from_file_location("provision_canary_drm_credentials", FILE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

DRM_KEYS = {"KINESCOPE_DRM_USERNAME", "KINESCOPE_DRM_PASSWORD", "KINESCOPE_DRM_TOKEN_SECRET"}
ENVS_PATH = f"/applications/{MODULE.APP_UUID}/envs"


class FakeCoolify:
    def __init__(self):
        self.app = {
            "uuid": MODULE.APP_UUID,
            "git_commit_sha": MODULE.SOURCE,
            "fqdn": None,
            "name": "flexperiment-commerce-v2-canary",
            "settings": {"is_auto_deploy_enabled": False},
        }
        self.rows = [
            {"key": key, "value": value, "is_literal": True, "is_preview": False}
            for key, value in {
                "PAYMENT_MODE": "disabled",
                "MARKETING_BROADCASTS_ENABLED": "false",
                "KINESCOPE_DELIVERY_MODE": "open",
                "SOURCE_COMMIT": MODULE.SOURCE,
            }.items()
        ]
        self.mutations = []
        self.fail_after_post_key = None
        self.fail_once = False
        self.sequence = 0

    def __call__(self, _opener, token, method, path, body=None):
        assert token == "fake-coolify-token"
        if method == "GET" and path == f"/applications/{MODULE.APP_UUID}":
            return dict(self.app)
        if method == "GET" and path == ENVS_PATH:
            return [dict(row) for row in self.rows]
        # All mutations must target this one canary app. A provider or production
        # call, or a broader env update, fails the test immediately.
        assert path == ENVS_PATH or path.startswith(ENVS_PATH + "/")
        assert method in {"POST", "DELETE"}
        self.mutations.append((method, path, dict(body) if body else None))
        if method == "POST":
            assert path == ENVS_PATH
            assert set(body) == {"key", "value", "is_preview", "is_buildtime", "is_runtime"}
            assert body["key"] in DRM_KEYS
            assert body["is_preview"] is False
            assert body["is_buildtime"] is False
            assert body["is_runtime"] is True
            self.sequence += 1
            main = {**body, "is_literal": True, "uuid": f"main-{self.sequence}"}
            preview = {**main, "is_preview": True, "uuid": f"preview-{self.sequence}"}
            self.rows.extend((main, preview))  # Observed Coolify 4.4.6 mirroring.
            if self.fail_once and self.fail_after_post_key == body["key"]:
                self.fail_once = False
                raise RuntimeError("CONTROL_STATUS_REFUSED")
            return {"uuid": main["uuid"]}
        assert body is None
        uuid = path.removeprefix(ENVS_PATH + "/")
        matches = [row for row in self.rows if row.get("uuid") == uuid]
        assert len(matches) == 1 and matches[0]["is_preview"] is True
        assert matches[0]["key"] in DRM_KEYS
        self.rows.remove(matches[0])
        return {}


class ProvisionCanaryDrmCredentialsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "owner"
        self.root.mkdir(mode=0o700)
        self.secret_dir = self.root / "kinescope"
        self.secret_dir.mkdir(mode=0o700)
        self.secret_file = self.secret_dir / "drm-credentials.json"
        self.config_file = self.root / "deploy-config.json"
        self.write_private(self.config_file, self.valid_config())
        self.write_private(self.root / "coolify-api.token", "fake-coolify-token")
        self.write_private(self.secret_dir / "api-token", "6964ab60-0ba1-4738-82d2-eada67792e0b")
        self.coolify = FakeCoolify()

    def write_private(self, path, value):
        path.write_text(json.dumps(value) if isinstance(value, dict) else value)
        path.chmod(0o600)

    def valid_config(self):
        return {"apps": {"canary": MODULE.APP_UUID, "production": "different-production-app"}}

    def run_owner(self):
        output = io.StringIO()
        self.latest_output = output
        with patch.object(MODULE, "ROOT", self.root), \
             patch.object(MODULE, "SECRET_DIR", self.secret_dir), \
             patch.object(MODULE, "SECRET_FILE", self.secret_file), \
             patch.object(MODULE, "OWNER_UID", os.getuid()), \
             patch.object(MODULE, "api", self.coolify), \
             patch.object(MODULE.urllib.request, "build_opener", return_value=object()), \
             patch.object(sys, "argv", [str(FILE), "--apply"]), \
             contextlib.redirect_stdout(output):
            MODULE.main()
        return output.getvalue()

    def assert_clean_secret_state(self):
        self.assertEqual({row["key"] for row in self.coolify.rows if row["key"] in DRM_KEYS}, DRM_KEYS)
        self.assertTrue(all(len([row for row in self.coolify.rows if row["key"] == key]) == 1 for key in DRM_KEYS))
        self.assertFalse(any(row.get("is_preview") for row in self.coolify.rows if row["key"] in DRM_KEYS))
        saved = json.loads(self.secret_file.read_text())
        self.assertEqual(set(saved), {"username", "password"})
        self.assertEqual(self.secret_file.stat().st_mode & 0o777, 0o600)
        return saved

    def test_mirrored_preview_deleted_and_rerun_is_read_only(self):
        output = self.run_owner()
        saved = self.assert_clean_secret_state()
        self.assertEqual(len([event for event in self.coolify.mutations if event[0] == "POST"]), 3)
        self.assertEqual(len([event for event in self.coolify.mutations if event[0] == "DELETE"]), 3)
        self.assertNotIn(saved["password"], output)
        self.assertNotIn("fake-coolify-token", output)
        self.coolify.mutations.clear()
        self.assertEqual(self.run_owner(), "CANARY_DRM_CREDENTIALS_SAVED\n")
        self.assertEqual(self.coolify.mutations, [])
        self.assertEqual(json.loads(self.secret_file.read_text()), saved)

    def test_unknown_post_outcome_reconciles_on_rerun_without_duplicates(self):
        self.coolify.fail_after_post_key = "KINESCOPE_DRM_PASSWORD"
        self.coolify.fail_once = True
        with self.assertRaisesRegex(RuntimeError, "CONTROL_STATUS_REFUSED"):
            self.run_owner()
        staged = json.loads(self.secret_file.read_text())
        self.assertNotIn(staged["password"], self.latest_output.getvalue())
        self.assertNotIn(staged["signingSecret"], self.latest_output.getvalue())
        self.assertEqual(set(staged), {"username", "password", "signingSecret"})
        self.assertEqual(len([row for row in self.coolify.rows if row["key"] == "KINESCOPE_DRM_PASSWORD"]), 2)
        output = self.run_owner()
        saved = self.assert_clean_secret_state()
        self.assertEqual(saved["password"], staged["password"])
        self.assertEqual(len([event for event in self.coolify.mutations if event[0] == "POST"]), 3)
        self.assertNotIn(staged["password"], output)
        self.assertNotIn(staged["signingSecret"], output)

    def test_wrong_identity_source_or_payment_mode_refuses_before_mutation(self):
        changes = {
            "wrong_canary_config": lambda: self.write_private(self.config_file, {"apps": {"canary": "other-app"}}),
            "production_identity": lambda: self.write_private(self.config_file, {"apps": {"canary": MODULE.APP_UUID, "production": MODULE.APP_UUID}}),
            "wrong_app": lambda: self.coolify.app.update(uuid="different-app"),
            "wrong_app_source": lambda: self.coolify.app.update(git_commit_sha="different-source"),
            "wrong_env_source": lambda: next(row for row in self.coolify.rows if row["key"] == "SOURCE_COMMIT").update(value="different-source"),
            "payment_enabled": lambda: next(row for row in self.coolify.rows if row["key"] == "PAYMENT_MODE").update(value="live"),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                self.write_private(self.config_file, self.valid_config())
                self.coolify = FakeCoolify()
                change()
                with self.assertRaisesRegex(RuntimeError, "REFUSED"):
                    self.run_owner()
                self.assertEqual(self.coolify.mutations, [])
                self.assertFalse(self.secret_file.exists())

    def test_existing_credential_conflict_or_unknown_preview_refuses(self):
        self.run_owner()
        saved = json.loads(self.secret_file.read_text())
        for mutation in ("main_value", "preview_copy"):
            with self.subTest(mutation=mutation):
                row = next(row for row in self.coolify.rows if row["key"] == "KINESCOPE_DRM_PASSWORD")
                if mutation == "main_value":
                    row["value"] = "unexpected-password"
                else:
                    self.coolify.rows.append({**row, "is_preview": True, "uuid": "unexpected-preview"})
                self.coolify.mutations.clear()
                with self.assertRaisesRegex(RuntimeError, "DRM_ENVIRONMENT_CONFLICT"):
                    self.run_owner()
                self.assertEqual(self.coolify.mutations, [])
                self.assertEqual(json.loads(self.secret_file.read_text()), saved)
                if mutation == "main_value":
                    row["value"] = saved["password"]
                else:
                    self.coolify.rows.pop()


if __name__ == "__main__":
    unittest.main()
