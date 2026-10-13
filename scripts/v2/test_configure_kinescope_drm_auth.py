import contextlib
import importlib.util
import io
import pathlib
import sys
import unittest
from unittest.mock import patch


FILE = pathlib.Path(__file__).with_name("configure_kinescope_drm_auth.py")
SPEC = importlib.util.spec_from_file_location("configure_kinescope_drm_auth", FILE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, status, body=b"{}"):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.body


class Opener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.methods = []

    def open(self, request, timeout):
        self.methods.append(request.get_method())
        assert timeout == 15
        return next(self.responses)


class ConfigureKinescopeDrmAuthTest(unittest.TestCase):
    def run_script(self, opener):
        output = io.StringIO()
        with patch.object(sys, "argv", [str(FILE), "--apply"]), \
             patch.object(MODULE.getpass, "getpass", side_effect=["user-secret", "password-secret", "token-secret"]), \
             patch.object(MODULE.urllib.request, "build_opener", return_value=opener), \
             contextlib.redirect_stdout(output):
            MODULE.main()
        self.assertNotIn("password-secret", output.getvalue())
        self.assertNotIn("token-secret", output.getvalue())
        return output.getvalue()

    def test_closed_callback_prevents_provider_put(self):
        opener = Opener([Response(503)])
        with self.assertRaisesRegex(SystemExit, "no provider mutation"):
            self.run_script(opener)
        self.assertEqual(opener.methods, ["POST"])

    def test_authenticated_callback_then_project_put_and_readback(self):
        config = b'{"data":{"url":"https://canary-api.flexperiment.ru/v1/kinescope/drm/authorize","strict":true,"password":"password-secret"}}'
        opener = Opener([Response(400), Response(200), Response(200, config)])
        output = self.run_script(opener)
        self.assertEqual(opener.methods, ["POST", "PUT", "GET"])
        self.assertIn("PROJECT_DRM_AUTH_CONFIGURED", output)

    def test_readback_requires_strict(self):
        config = b'{"data":{"url":"https://canary-api.flexperiment.ru/v1/kinescope/drm/authorize","strict":false}}'
        opener = Opener([Response(400), Response(200), Response(200, config)])
        with self.assertRaisesRegex(SystemExit, "strict=true"):
            self.run_script(opener)
        self.assertEqual(opener.methods, ["POST", "PUT", "GET"])

    def test_provider_rejection_does_not_print_response_or_retry(self):
        opener = Opener([Response(400), Response(403, b'{"password":"password-secret"}')])
        output = io.StringIO()
        with patch.object(sys, "argv", [str(FILE), "--apply", "--owner-files"]), \
             patch.object(MODULE, "owner_credentials", return_value=("user-secret", "password-secret", "token-secret")), \
             patch.object(MODULE.getpass, "getpass", side_effect=AssertionError("hidden prompt unexpected")), \
             patch.object(MODULE.urllib.request, "build_opener", return_value=opener), \
             contextlib.redirect_stdout(output), \
             self.assertRaisesRegex(SystemExit, "no blind retry"):
            MODULE.main()
        self.assertEqual(opener.methods, ["POST", "PUT"])
        self.assertNotIn("password-secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
