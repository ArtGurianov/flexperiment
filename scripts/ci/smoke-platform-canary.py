"""Actual built Next/Payload image; isolated synthetic upstream, no public ports."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import uuid


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=60).decode().strip()


def main():
    image = os.environ["PLATFORM_CANARY_TEST_IMAGE"]
    sha = os.environ["SOURCE_COMMIT"]
    prefix = "platform-canary-test-" + uuid.uuid4().hex[:12]
    network, app, upstream = prefix + "-net", prefix + "-app", prefix + "-upstream"
    data, backups = prefix + "-editorial", prefix + "-backups"
    checks = 0

    def check(condition):
        nonlocal checks
        if not condition:
            raise RuntimeError("PLATFORM_CANARY_IMAGE_ASSERTION_FAILED")
        checks += 1

    def request(path, host="canary-platform.flexperiment.ru", method="GET", headers=None):
        script = "const [p,h,m,headers]=process.argv.slice(1);fetch('http://127.0.0.1:3001'+p,{method:m,headers:{host:h,'content-type':'application/json',...JSON.parse(headers)},body:m==='POST'?JSON.stringify({email:'synthetic@invalid.example',password:'synthetic-private-password'}):undefined,redirect:'manual',signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()}))).catch(()=>process.exit(1))"
        return json.loads(run("docker", "exec", app, "node", "-e", script, path, host, method, json.dumps(headers or {})))

    try:
        run("docker", "network", "create", "--internal", network)
        for volume in (data, backups):
            run("docker", "volume", "create", volume)
        mock = "const http=require('http');http.createServer((q,r)=>{const ready={ok:true,service:'commerce-v2',sourceCommit:process.env.SOURCE_COMMIT,foundationMode:false,core:{database:'ok',paymentMode:'disabled'},capabilities:{refref:'ready'}};r.setHeader('content-type','application/json');if(q.url==='/readyz')return r.end(JSON.stringify(ready));if(q.url.startsWith('/v1/checkout')){r.statusCode=503;return r.end(JSON.stringify({code:'PAYMENTS_DISABLED'}))}r.setHeader('set-cookie','session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax');r.setHeader('cache-control','public');r.end(JSON.stringify({host:q.headers.host,proto:q.headers['x-forwarded-proto'],cookie:q.headers.cookie,xff:q.headers['x-forwarded-for']??null,url:q.url}))}).listen(3002,'0.0.0.0')"
        run("docker", "run", "-d", "--name", upstream, "--network", network,
            "--network-alias", "xzuy7pk5y6ywjr9kh6nsk5ap", "-e", f"SOURCE_COMMIT={sha}",
            "--entrypoint", "node", image, "-e", mock)
        env = {
            "PLATFORM_V2_CANARY": "true", "PLATFORM_ORIGIN": "https://canary-platform.flexperiment.ru",
            "LAB_ORIGIN": "https://canary-lab.flexperiment.ru", "ADMIN_ORIGIN": "https://canary-admin.flexperiment.ru",
            "API_ORIGIN": "https://canary-api.flexperiment.ru", "COMMERCE_INTERNAL_ORIGIN": "http://xzuy7pk5y6ywjr9kh6nsk5ap:3002",
            "PLATFORM_EXPECTED_COMMERCE_SHA": sha, "PAYLOAD_DATABASE_URL": "file:/var/lib/flexperiment-platform-canary/platform.sqlite",
            "PAYLOAD_SECRET": "synthetic-payload-runtime-key-32bytes", "PLATFORM_COMMERCE_SERVICE_TOKEN": "synthetic-canary-runtime-token-32bytes",
            "PAYLOAD_JOBS_ENABLED": "false", "PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false",
            "DEPLOY_ENV": "staging",
        }
        args = ["docker", "run", "-d", "--name", app, "--network", network,
                "-v", f"{data}:/var/lib/flexperiment-platform-canary", "-v", f"{backups}:/var/lib/flexperiment-platform-canary-backups"]
        for key, value in env.items():
            args.extend(["-e", f"{key}={value}"])
        run(*args, image)
        ready = False
        for _ in range(45):
            try:
                ready = request("/readyz")["status"] == 200
            except Exception:
                pass
            if ready:
                break
            time.sleep(1)
        if not ready:
            # Inspect only the task-created synthetic runtime. Never echo its raw log.
            state = json.loads(run("docker", "inspect", "--format", "{{json .State}}", app))
            logs = subprocess.check_output(["docker", "logs", "--tail", "100", app], stderr=subprocess.STDOUT, timeout=10).decode()
            category = "PACKAGE_MANAGER_BOOT" if "Corepack" in logs or "corepack" in logs else "APPLICATION_BOOT"
            print(json.dumps({"startupFailure": category, "running": state["Running"], "exitCode": state["ExitCode"]}))
        check(ready)
        check(run("docker", "exec", "-e", "COREPACK_ENABLE_NETWORK=0", app, "pnpm", "--version") == "10.29.3")
        check(run("docker", "exec", app, "stat", "-c", "%a", "/var/lib/flexperiment-platform-canary") == "700")
        check(run("docker", "exec", app, "stat", "-c", "%a", "/var/lib/flexperiment-platform-canary/platform.sqlite") == "600")
        identity = json.loads(request("/identity")["body"])
        check(identity["service"] == "platform" and identity["sourceCommit"] == sha)
        response = request("/v1/me?test=synthetic", headers={"Cookie": "session=synthetic", "X-Forwarded-Proto": "http", "X-Forwarded-For": "spoof"})
        body = json.loads(response["body"])
        check(response["status"] == 200 and body["host"] == "canary-platform.flexperiment.ru" and body["proto"] == "https" and body["xff"] is None)
        check(body["cookie"] == "session=synthetic" and body["url"] == "/v1/me?test=synthetic")
        check(response["headers"]["cache-control"] == "no-store" and "Secure" in response["headers"]["set-cookie"])
        for path in ("/v1/public/tours", "/v1/partner", "/v1/admin/v2"):
            check(request(path)["status"] == 404)
        check(request("/v1/me", host="flexperiment.ru")["status"] == 403)
        check(request("/v1/me", headers={"Origin": "https://foreign.example"})["status"] == 403)
        check(request("/v1/checkout")["status"] == 503)
        check(request("/api/users", method="POST")["status"] == 403)
        run("docker", "stop", upstream)
        check(request("/readyz")["status"] == 503)
        with tempfile.TemporaryDirectory(prefix="editorial-image-restore-") as temporary:
            root = Path(temporary)
            key = root / "recovery.key"
            run("age-keygen", "-o", str(key))
            recipient = run("age-keygen", "-y", str(key))
            proof = json.loads(run("docker", "exec", "-e", f"PLATFORM_BACKUP_AGE_RECIPIENT={recipient}", app,
                                   "python3", "/app/scripts/v2/platform-backup.py"))
            archive = root / "snapshot.age"
            run("docker", "cp", f"{app}:/var/lib/flexperiment-platform-canary-backups/{proof['filename']}", str(archive))
            import hashlib
            check(hashlib.sha256(archive.read_bytes()).hexdigest() == proof["sha256"])
            restored = root / "restored.sqlite"
            run("age", "-d", "-i", str(key), "-o", str(restored), str(archive))
            with sqlite3.connect(restored) as db:
                check(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok")
                check(db.execute("SELECT COUNT(*) FROM payload_migrations").fetchone()[0] == 6)
                check(db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0)
        print(json.dumps({"scope": "isolated_actual_platform_image", "checks": checks, "status": "PASS"}))
    finally:
        # Only task-created exact names; never existing runtimes or volumes.
        for container in (app, upstream):
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for volume in (data, backups):
            subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
