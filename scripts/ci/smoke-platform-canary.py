"""Actual Payload-free Next image; isolated synthetic upstream, no public ports."""
import json
import os
import subprocess
import time
import uuid


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=60).decode().strip()


def main():
    image = os.environ["PLATFORM_CANARY_TEST_IMAGE"]
    sha = os.environ["SOURCE_COMMIT"]
    prefix = "platform-canary-test-" + uuid.uuid4().hex[:12]
    network, app, upstream = prefix + "-net", prefix + "-app", prefix + "-upstream"
    checks = 0

    def check(condition):
        nonlocal checks
        if not condition:
            raise RuntimeError("PLATFORM_CANARY_IMAGE_ASSERTION_FAILED")
        checks += 1

    def request(path, host="canary-platform.flexperiment.ru", method="GET", headers=None):
        script = "const [p,h,m,headers]=process.argv.slice(1);const q=require('http').request('http://127.0.0.1:3001'+p,{method:m,headers:{host:h,'content-type':'application/json',...JSON.parse(headers)},signal:AbortSignal.timeout(5000)},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{const hdr={...r.headers};if(Array.isArray(hdr['set-cookie']))hdr['set-cookie']=hdr['set-cookie'].join(',');console.log(JSON.stringify({status:r.statusCode,headers:hdr,body:b}))})});q.on('error',()=>process.exit(1));q.end(m==='POST'?JSON.stringify({email:'synthetic@invalid.example',password:'synthetic-private-password'}):undefined)"
        return json.loads(run("docker", "exec", app, "node", "-e", script, path, host, method, json.dumps(headers or {})))

    try:
        run("docker", "network", "create", "--internal", network)
        mock = "const http=require('http');http.createServer((q,r)=>{const ready={ok:true,service:'commerce-v2',sourceCommit:process.env.SOURCE_COMMIT,foundationMode:false,core:{database:'ok',paymentMode:'disabled'},capabilities:{refref:'ready'}};r.setHeader('content-type','application/json');if(q.url==='/readyz')return r.end(JSON.stringify(ready));if(q.url.startsWith('/v1/checkout')){r.statusCode=503;return r.end(JSON.stringify({code:'PAYMENTS_DISABLED'}))}r.setHeader('set-cookie','session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax');r.setHeader('cache-control','public');r.end(JSON.stringify({host:q.headers.host,proto:q.headers['x-forwarded-proto'],cookie:q.headers.cookie,xff:q.headers['x-forwarded-for']??null,url:q.url}))}).listen(3002,'0.0.0.0')"
        run("docker", "run", "-d", "--name", upstream, "--network", network,
            "--network-alias", "xzuy7pk5y6ywjr9kh6nsk5ap", "-e", f"SOURCE_COMMIT={sha}",
            "--entrypoint", "node", image, "-e", mock)
        env = {
            "PLATFORM_V2_CANARY": "true", "PLATFORM_ORIGIN": "https://canary-platform.flexperiment.ru",
            "LAB_ORIGIN": "https://canary-lab.flexperiment.ru", "ADMIN_ORIGIN": "https://canary-admin.flexperiment.ru",
            "API_ORIGIN": "https://canary-api.flexperiment.ru", "COMMERCE_INTERNAL_ORIGIN": "http://xzuy7pk5y6ywjr9kh6nsk5ap:3002",
            "PLATFORM_EXPECTED_COMMERCE_SHA": sha,
            "PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false",
            "DEPLOY_ENV": "staging",
            "SMARTCAPTCHA_SERVER_KEY": "ci-server-secret-never-serialize",
        }
        def start_app(site_key):
            args = ["docker", "run", "-d", "--name", app, "--network", network]
            for key, value in {**env, "SMARTCAPTCHA_CLIENT_KEY": site_key}.items():
                args.extend(["-e", f"{key}={value}"])
            run(*args, image)

        start_app("ci-runtime-public-key-A")
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
        mounts = json.loads(run("docker", "inspect", "--format", "{{json .Mounts}}", app))
        check(mounts == [])
        for retired in ("/var/lib/flexperiment-platform-canary", "/app/scripts/v2/platform-backup.py",
                        "/app/apps/platform/payload.config.ts", "/app/apps/platform/migrations",
                        "/app/apps/platform/node_modules/payload"):
            check(run("docker", "exec", app, "test", "!", "-e", retired) == "")
        identity = json.loads(request("/identity")["body"])
        check(identity["service"] == "platform" and identity["sourceCommit"] == sha)
        account = request("/account")
        check(account["status"] == 200 and "ci-runtime-public-key-A" in account["body"])
        check("ci-server-secret-never-serialize" not in account["body"])
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
        check(request("/api/users", method="POST")["status"] == 404)
        check(request("/api/users")["status"] == 404)
        check(request("/admin")["status"] == 404)
        # One built image must evaluate a different public key at runtime;
        # NEXT_PUBLIC_ build-time freezing was the actual canary defect.
        first_image_id = json.loads(run("docker", "inspect", app))[0]["Image"]
        run("docker", "rm", "-f", app)
        start_app("ci-runtime-public-key-B")
        for _ in range(30):
            try:
                if request("/readyz")["status"] == 200:
                    break
            except Exception:
                pass
            time.sleep(.5)
        else:
            raise RuntimeError("SECOND_PLATFORM_RUNTIME_NOT_READY")
        account = request("/account")
        check(json.loads(run("docker", "inspect", app))[0]["Image"] == first_image_id)
        check(account["status"] == 200 and "ci-runtime-public-key-B" in account["body"])
        check("ci-runtime-public-key-A" not in account["body"] and "ci-server-secret-never-serialize" not in account["body"])
        run("docker", "stop", upstream)
        check(request("/readyz")["status"] == 503)
        print(json.dumps({"scope": "isolated_actual_platform_image", "checks": checks, "status": "PASS"}))
    finally:
        # Only task-created exact names; never existing runtimes or volumes.
        for container in (app, upstream):
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "network", "rm", network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
