import contextlib
import http.client
import io
import json
import pathlib
import re
import threading
import unittest
from retired_server import BODY, make_server


class RetirementBoundaryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_all_methods_and_legacy_paths_are_static_without_token_execution_or_logging(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "PROPFIND"]:
                for path in ["/", "/refund", "/refund/confirm?token=SECRET_CONFIRMATION", "/ticket/SECRET_TICKET", "/v1/public/checkout", "/v1/admin/orders", "/v1/webhooks/tochka"]:
                    with self.subTest(method=method, path=path):
                        conn = http.client.HTTPConnection(*self.server.server_address)
                        conn.request(method, path, body="SECRET_BODY" if method == "POST" else None)
                        response = conn.getresponse()
                        self.assertEqual(response.status, 410)
                        self.assertEqual(response.read(), b"" if method == "HEAD" else BODY)
                        self.assertEqual(response.getheader("X-Flexperiment-Retired"), "LAB-V1")
                        self.assertEqual(response.getheader("Cache-Control"), "no-store")
                        self.assertEqual(response.getheader("Referrer-Policy"), "no-referrer")
                        self.assertIsNone(response.getheader("Location"))
                        self.assertIsNone(response.getheader("Set-Cookie"))
                        conn.close()
        self.assertEqual(errors.getvalue(), "")
        self.assertNotIn(b"SECRET", BODY)
        self.assertNotIn(b"refunds@", BODY)
        self.assertIn(b"art@flexperiment.ru", BODY)

    def test_only_explicit_legacy_hosts_route_to_private_static_service(self):
        config = json.loads(pathlib.Path(__file__).with_name("lab-v1-retired.yaml").read_text())
        expected = {"flexperiment.ru", "www.flexperiment.ru", "api.flexperiment.ru", "www.api.flexperiment.ru",
                    "admin.flexperiment.ru", "www.admin.flexperiment.ru", "lab.flexperiment.ru", "partner.flexperiment.ru"}
        for router in config["http"]["routers"].values():
            self.assertEqual(set(re.findall(r"Host\(`([^`]+)`\)", router["rule"])), expected)
            self.assertNotIn("HostRegexp", router["rule"])
            self.assertEqual(router["service"], "lab-v1-retired")
            self.assertEqual(router["priority"], 100000)
        service = config["http"]["services"]["lab-v1-retired"]["loadBalancer"]
        self.assertEqual(service["servers"], [{"url": "http://10.0.1.1:18139"}])


if __name__ == "__main__":
    unittest.main()
