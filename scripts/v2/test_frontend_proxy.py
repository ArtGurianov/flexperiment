#!/usr/bin/env python3
"""Real nginx + isolated synthetic upstream; never contact a VPS or provider.

Default mode mounts reviewed config onto nginx. CI's docker-build job runs the
same suite against both fully built frontend images, without config overrides.
"""
import base64
from email.message import Message
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
CANARY = "xzuy7pk5y6ywjr9kh6nsk5ap"
COMMIT = os.environ.get("SOURCE_COMMIT", "1" * 40)
SYNTHETIC = "synthetic-magic-link-token-for-proxy-test"
FIXTURE = r"""
const http = require('node:http');
http.createServer((req, res) => {
 let body = ''; req.on('data', c => body += c);
 req.on('end', () => {
  if (req.url.startsWith('/readyz')) {
   res.writeHead(req.url.includes('unavailable=1') ? 503 : 200, {'Content-Type':'application/json'});
   return res.end(JSON.stringify({ok: !req.url.includes('unavailable=1')}));
  }
  res.writeHead(req.url.includes('/error') ? 500 : 200, {
   'Content-Type':'application/json',
   'Set-Cookie':'test.session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax',
   'Location':'https://' + req.headers.host + '/account?from=magic-link',
  });
  res.end(JSON.stringify({method:req.method,url:req.url,headers:req.headers,body}));
 });
}).listen(3002,'0.0.0.0');
"""
REQUEST = r"""
const http = require('node:http');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const req = http.request({hostname:input.container, port:80, path:input.path,
 method:input.body === null ? 'GET' : 'POST', headers:input.headers}, res => {
 const chunks=[]; res.on('data', c => chunks.push(c));
 res.on('end', () => console.log(JSON.stringify({status:res.statusCode,
  headers:res.headers, body:Buffer.concat(chunks).toString('base64')})));
});
req.setTimeout(3000, () => {req.destroy(); process.exit(2)});
req.on('error', () => process.exit(2));
if (input.body !== null) req.end(Buffer.from(input.body, 'base64')); else req.end();
"""


def docker(*args, check=True, input=None):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True, timeout=45, input=input)


class FrontendProxy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prefix = "v2-proxy-test-" + uuid.uuid4().hex[:12]
        cls.network = cls.prefix + "-net"
        cls.containers = []
        cls.tmp = tempfile.TemporaryDirectory(prefix="v2-proxy-fixture-")
        cls.services = {}
        cls.addClassCleanup(cls.cleanup)
        docker("network", "create", "--internal", cls.network)
        upstream = cls.prefix + "-upstream"
        docker("run", "--detach", "--name", upstream, "--network", cls.network,
               "--network-alias", CANARY, "node:22-bookworm-slim", "node", "-e", FIXTURE)
        cls.containers.append(upstream)
        for service in ("lab-v2", "admin-v2"):
            name = cls.prefix + "-" + service
            cls.containers.append(name)
            cls.services[service] = cls.start(name, service)

    @classmethod
    def cleanup(cls):
        for container in cls.containers:
            docker("rm", "--force", container, check=False)
        docker("network", "rm", cls.network, check=False)
        cls.tmp.cleanup()

    @classmethod
    def arguments(cls, service, config=None):
        image = os.environ.get("V2_FRONTEND_" + service.split('-')[0].upper() + "_IMAGE")
        if image:
            return (["--volume", f"{config}:/etc/nginx/v2:ro"] if config else []) + [image]
        identity = Path(cls.tmp.name) / service
        identity.mkdir(exist_ok=True)
        descriptor = identity / "identity.json"
        if not descriptor.exists():
            descriptor.write_text(json.dumps({"schema": "flexperiment.build-identity/1",
                                              "service": service, "sourceCommit": COMMIT}))
            descriptor.chmod(0o444)
            (identity / "service").write_text(service + "\n")
            (identity / "service").chmod(0o444)
        return ["--volume", f"{identity}:/app/.identity:ro", "--volume",
                f"{config or ROOT / 'deploy/v2/frontends'}:/etc/nginx/v2:ro",
                "--entrypoint", "/bin/sh", "nginx:1.29-alpine", "/etc/nginx/v2/start.sh"]

    @classmethod
    def start(cls, name, service, config=None):
        docker("run", "--detach", "--name", name, "--network", cls.network,
               "--env", f"V2_COMMERCE_UPSTREAM={CANARY}:3002",
               "--env", "SOURCE_COMMIT=" + "f" * 40, *cls.arguments(service, config))
        for _ in range(30):
            try:
                if cls.request(service, "/readyz", container=name)[0] == 200:
                    return name
            except (OSError, subprocess.CalledProcessError):
                pass
            time.sleep(0.1)
        raise AssertionError("isolated frontend did not become ready")

    @classmethod
    def request(cls, service, path, *, host=None, body=None, headers=None, container=None):
        host = host or "canary-" + service.split('-')[0] + ".flexperiment.ru"
        request_headers = {"Host": host, **(headers or {})}
        if body is not None:
            request_headers["Content-Length"] = str(len(body))
        payload = {"container": container or cls.services[service], "path": path,
                   "headers": request_headers,
                   "body": None if body is None else base64.b64encode(body).decode()}
        result = json.loads(docker("exec", "-i", cls.prefix + "-upstream", "node", "-e", REQUEST,
                                   input=json.dumps(payload)).stdout)
        response_headers = Message()
        for key, values in result["headers"].items():
            for value in values if isinstance(values, list) else [values]:
                response_headers[key] = value
        return result["status"], response_headers, base64.b64decode(result["body"])

    def test_identity_is_baked_not_runtime_override(self):
        for service in self.services:
            status, headers, body = self.request(service, "/identity")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"schema": "flexperiment.build-identity/1",
                                               "service": service, "sourceCommit": COMMIT})
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(docker("exec", self.prefix + "-" + service, "stat", "-c", "%a",
                                    "/app/.identity/identity.json").stdout.strip(), "444")

    def test_foreign_host_and_partner_realm_refuse(self):
        for service in self.services:
            for host in ("admin.flexperiment.ru", "lab.flexperiment.ru",
                         "partner.flexperiment.ru", "untrusted.invalid"):
                self.assertEqual(self.request(service, "/v1/admin/session", host=host)[0], 404)
            for path in ("/partner", "/partner/login", "/v1/partner/session", "/internal/catalog"):
                self.assertEqual(self.request(service, path)[0], 404)

    def test_legacy_and_cross_surface_api_refuse(self):
        for path in ("/v1/public/tour", "/v1/admin/orders", "/v1/admin/occurrences"):
            for service in self.services:
                self.assertEqual(self.request(service, path)[0], 404)
        self.assertEqual(self.request("lab-v2", "/v1/admin/v2/catalog")[0], 404)
        self.assertEqual(self.request("admin-v2", "/v1/auth/get-session")[0], 404)
        self.assertEqual(self.request("lab-v2", "/v1/auth-other")[0], 404)

    def test_v2_allowlists(self):
        for root in ("auth/get-session", "me", "lessons/access", "checkout/preview", "email/unsubscribe", "legal/current"):
            self.assertEqual(self.request("lab-v2", "/v1/" + root)[0], 200)
        for path in ("login", "session", "logout", "v2/catalog", "v2/orders"):
            self.assertEqual(self.request("admin-v2", "/v1/admin/" + path)[0], 200)

    def test_body_cookie_origin_and_trusted_proxy_headers(self):
        for service, path in (("lab-v2", "/v1/auth/sign-in/magic-link"), ("admin-v2", "/v1/admin/login")):
            origin = "https://canary-" + service.split('-')[0] + ".flexperiment.ru"
            status, headers, body = self.request(service, path + "?token=" + SYNTHETIC,
                body=b'{"synthetic":true}', headers={"Cookie": "test.session=synthetic",
                "Origin": origin, "Content-Type": "application/json", "X-Forwarded-Host": "production.invalid",
                "X-Forwarded-Proto": "http", "X-Forwarded-For": "spoofed"})
            echoed = json.loads(body)
            self.assertEqual(status, 200)
            self.assertEqual(echoed["method"], "POST")
            self.assertEqual(echoed["url"], path + "?token=" + SYNTHETIC)
            self.assertEqual(echoed["body"], '{"synthetic":true}')
            self.assertEqual(echoed["headers"]["cookie"], "test.session=synthetic")
            self.assertEqual(echoed["headers"]["origin"], origin)
            self.assertEqual(echoed["headers"]["x-forwarded-host"], origin.removeprefix("https://"))
            self.assertEqual(echoed["headers"]["x-forwarded-proto"], "https")
            self.assertNotEqual(echoed["headers"]["x-forwarded-for"], "spoofed")
            self.assertEqual(headers["Set-Cookie"], "test.session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax")
            self.assertEqual(headers["Location"], origin + "/account?from=magic-link")
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_readiness_propagates_upstream_unavailable(self):
        for service in self.services:
            self.assertEqual(self.request(service, "/readyz?unavailable=1")[0], 503)
            # Private Coolify healthchecks have no storefront Host. This is a
            # read-only readiness exception, not an application-route fallback.
            self.assertEqual(self.request(service, "/readyz", host="127.0.0.1")[0], 200)
            self.assertEqual(self.request(service, "/readyz?unavailable=1", host="127.0.0.1")[0], 503)
            self.assertEqual(self.request(service, "/", host="127.0.0.1")[0], 404)

    def test_errors_and_oversize_do_not_log_tokens(self):
        for service, path in (("lab-v2", "/v1/auth/error"), ("admin-v2", "/v1/admin/v2/error")):
            self.assertEqual(self.request(service, path + "?token=" + SYNTHETIC)[0], 500)
            self.assertEqual(self.request(service, "/unknown?token=" + SYNTHETIC)[0], 404)
            self.assertEqual(self.request(service, path, body=(SYNTHETIC * 50000).encode())[0], 413)
            self.assertEqual(self.request(service, "/" + SYNTHETIC * 400)[0], 414)
            logs = docker("logs", self.prefix + "-" + service).stdout + docker("logs", self.prefix + "-" + service).stderr
            self.assertNotIn(SYNTHETIC, logs)
            self.assertNotIn(path, logs)

    def test_missing_foreign_and_legacy_upstreams_fail_closed(self):
        for index, value in enumerate(("", "commerce:3001", CANARY + ":3001",
                                      "gzngatkipv7dv3rkpuaigjg5:3002", "https://secret.invalid/" + SYNTHETIC,
                                      CANARY + ":3002\nignored")):
            name = self.prefix + "-invalid-" + str(index)
            self.containers.append(name)
            result = docker("run", "--name", name, "--network", self.network,
                            "--env", "V2_COMMERCE_UPSTREAM=" + value, *self.arguments("lab-v2"), check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("V2_FRONTEND_CONFIGURATION_INVALID", result.stderr)
            self.assertNotIn(SYNTHETIC, result.stdout + result.stderr)

    def test_causal_controls_detect_legacy_routing_and_token_logging(self):
        # Mutate only disposable copies, never tracked config or running apps.
        for mutation in ("legacy", "logging"):
            config = Path(self.tmp.name) / ("mutated-" + mutation)
            shutil.copytree(ROOT / "deploy/v2/frontends", config)
            if mutation == "legacy":
                file = config / "lab-v2.conf.template"
                content = file.read_text()
                insertion = "\n    location ^~ /v1/public/ { include /etc/nginx/v2/proxy.conf; proxy_pass http://$commerce_upstream; }\n"
                position = content.rfind("}")
                file.write_text(content[:position] + insertion + content[position:])
            else:
                file = config / "common.conf"
                file.write_text(file.read_text().replace("access_log off;", "access_log /dev/stdout;"))
            name = self.prefix + "-mutated-" + mutation
            self.containers.append(name)
            self.start(name, "lab-v2", config)
            path = "/v1/public/tour" if mutation == "legacy" else "/v1/auth/get-session?token=" + SYNTHETIC
            status, _, _ = self.request("lab-v2", path, container=name)
            if mutation == "legacy":
                with self.assertRaises(AssertionError):
                    self.assertEqual(status, 404)
            else:
                self.assertEqual(status, 200)
                logs = docker("logs", name).stdout + docker("logs", name).stderr
                with self.assertRaises(AssertionError):
                    self.assertNotIn(SYNTHETIC, logs)


if __name__ == "__main__":
    unittest.main()
