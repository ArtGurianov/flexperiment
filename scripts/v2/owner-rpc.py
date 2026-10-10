#!/usr/bin/env python3
"""Bounded owner operations for two isolated V2 apps; secrets never returned."""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import urllib.request

ROOT = "/root/flexperiment-v2-owner"
PUBLIC_ENV = {"NODE_ENV", "DEPLOY_ENV", "COMMERCE_V2_FOUNDATION_MODE", "COMMERCE_V2_ENVIRONMENT",
              "PAYMENT_MODE", "MARKETING_BROADCASTS_ENABLED", "KINESCOPE_DELIVERY_MODE", "SOURCE_COMMIT",
              "COMMERCE_V2_DATABASE_PATH", "COMMERCE_V2_BACKUP_PATH", "PORT", "MERCHANT_PROMOTION_PREFIX",
              "REFREF_READINESS_URL", "COMMERCE_V2_BACKUP_AGE_RECIPIENT"}


def private_json(path):
    info = os.stat(path)
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("OWNER_FILE_PERMISSIONS")
    with open(path, encoding="utf8") as source:
        return json.load(source)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("CONTROL_REDIRECT_REFUSED")


def api(method, path, body=None):
    info = os.stat(ROOT + "/coolify-api.token")
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("OWNER_TOKEN_PERMISSIONS")
    with open(ROOT + "/coolify-api.token", encoding="utf8") as source:
        token = source.read().strip()
    if not token or "\n" in token or "\r" in token:
        raise ValueError("OWNER_TOKEN_INVALID")
    request = urllib.request.Request("https://coolify.refref.ru/api/v1" + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("CONTROL_RESPONSE_LIMIT")
    return json.loads(raw)


def run(args):
    return subprocess.check_output(args, timeout=60, stderr=subprocess.DEVNULL).decode()


def container(uuid, optional=False):
    names = run(["docker", "ps", "--format", "{{.Names}}\t{{.ID}}"])
    found = [line.split("\t")[1] for line in names.splitlines() if line.split("\t")[0].startswith(uuid + "-")]
    if not found and optional:
        return None
    if len(found) != 1:
        raise ValueError("V2_CONTAINER_NOT_CONVERGED")
    return found[0]


def app_safe(value):
    result = {key: value.get(key) for key in ("uuid", "name", "git_repository", "git_branch", "git_commit_sha",
                                            "build_pack", "dockerfile_location", "ports_exposes", "fqdn")}
    result["settings"] = {"is_auto_deploy_enabled": value.get("settings", {}).get("is_auto_deploy_enabled")}
    result["portsMapped"] = bool(value.get("ports_mappings"))
    result["customRouting"] = bool(value.get("custom_labels"))
    result["hasUnsafeOverrides"] = any(bool(value.get(key)) for key in
                                        ("custom_docker_run_options", "pre_deployment_command", "post_deployment_command", "dockerfile", "start_command"))
    return result


def handle(message, config):
    apps = config["apps"]
    target = message.get("target")
    operation = message["operation"]
    if operation == "config":
        if set(apps) != {"canary", "production"} or apps["canary"] == apps["production"]:
            raise ValueError("V2_TARGETS_INVALID")
        return {"apps": apps}
    if operation == "api":
        path = message["path"]
        method = message["method"]
        match = re.fullmatch(r"/applications/([a-z0-9]{20,32})(/envs|/storages)?", path)
        if not match or match[1] not in apps.values() or method not in ("GET", "PATCH"):
            raise ValueError("CONTROL_SCOPE_REFUSED")
        body = message.get("body")
        if method == "PATCH":
            if match[2] is None:
                if set(body) != {"git_commit_sha"} or not re.fullmatch(r"[0-9a-f]{40}", body["git_commit_sha"]):
                    raise ValueError("CONTROL_WRITE_REFUSED")
            elif match[2] == "/envs":
                if set(body) != {"key", "value", "is_buildtime", "is_runtime", "is_preview"} or body["key"] != "SOURCE_COMMIT" \
                        or not re.fullmatch(r"[0-9a-f]{40}", body["value"]) or body["is_preview"] \
                        or body["is_buildtime"] is not True or body["is_runtime"] is not True:
                    raise ValueError("CONTROL_WRITE_REFUSED")
            else:
                raise ValueError("CONTROL_WRITE_REFUSED")
        value = api(method, path, body)
        if method != "GET":
            return {"saved": True}
        if match[2] == "/envs":
            return [{"key": row["key"], "is_preview": row.get("is_preview"), "is_runtime": row.get("is_runtime"),
                     "is_buildtime": row.get("is_buildtime"), "present": bool(row.get("real_value", row.get("value"))),
                     "length": len(row.get("real_value", row.get("value")) or ""),
                     "value": row.get("real_value", row.get("value")) if row["key"] in PUBLIC_ENV else None} for row in value]
        if match[2] == "/storages":
            return {"persistent_storages": [{key: row.get(key) for key in ("name", "mount_path", "host_path")}
                                            for row in value["persistent_storages"]],
                    "file_storages": [{} for _ in value["file_storages"]]}
        return app_safe(value)
    if target not in apps or not re.fullmatch(r"[a-z0-9]{20,32}", apps[target]):
        raise ValueError("V2_TARGET_INVALID")
    uuid = apps[target]
    if operation in ("deploy", "restart"):
        current = app_safe(api("GET", "/applications/" + uuid))
        if current["fqdn"] or current["portsMapped"] or current["customRouting"] or current["hasUnsafeOverrides"] \
                or current["dockerfile_location"] != "/Dockerfile.commerce-v2" \
                or current["name"] != ("flexperiment-commerce-v2" if target == "production" else "flexperiment-commerce-v2-canary"):
            raise ValueError("V2_APP_NOT_ISOLATED")
        if operation == "restart":
            api("POST", "/applications/" + uuid + "/restart")
            return {"requested": True}
        result = api("POST", "/deploy?uuid=" + uuid + "&force=false")
        deployment = result["deployments"][0]["deployment_uuid"]
        if not re.fullmatch(r"[a-zA-Z0-9-]+", deployment):
            raise ValueError("DEPLOYMENT_ID_INVALID")
        # Authorize exactly this queued deployment for later status reads.
        journal = ROOT + "/deployments/" + deployment + ".json"
        os.makedirs(ROOT + "/deployments", mode=0o700, exist_ok=True)
        with open(journal, "x", encoding="utf8") as output:
            os.chmod(journal, 0o600)
            json.dump({"target": target, "sha": message["sha"]}, output)
        return {"deployment": deployment}
    if operation == "deployment":
        deployment = message["deployment"]
        if not re.fullmatch(r"[a-zA-Z0-9-]+", deployment):
            raise ValueError("DEPLOYMENT_ID_INVALID")
        journal = private_json(ROOT + "/deployments/" + deployment + ".json")
        if journal["target"] != target:
            raise ValueError("DEPLOYMENT_TARGET_DIFFERS")
        value = api("GET", "/deployments/" + deployment)
        return {"status": value["status"], "commit": value.get("commit")}
    cid = container(uuid, message.get("optional", False))
    if cid is None:
        return None
    if operation == "runtime":
        metadata = json.loads(run(["docker", "inspect", "--format", '{"Id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"Mounts":{{json .Mounts}}}', cid]))
        code = 'Promise.all(["identity","readyz"].map(async p=>{const r=await fetch("http://127.0.0.1:3002/"+p,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error("NOT_READY");return r.json()})).then(([identity,ready])=>console.log(JSON.stringify({identity,ready}))).catch(()=>process.exit(1))'
        health = json.loads(run(["docker", "exec", cid, "node", "-e", code]))
        health.update({"containerId": metadata["Id"], "startedAt": metadata["startedAt"],
                       "mounts": [{"type": m["Type"], "name": m.get("Name"), "destination": m["Destination"], "rw": m["RW"]} for m in metadata["Mounts"]],
                       "identityMode": run(["docker", "exec", cid, "stat", "-c", "%a", "/app/.identity/identity.json"]).strip(),
                       "baked": json.loads(run(["docker", "exec", cid, "cat", "/app/.identity/identity.json"]))})
        return health
    if operation == "storage":
        command = message["command"]
        if command not in ("mark", "verify", "backup"):
            raise ValueError("STORAGE_COMMAND_REFUSED")
        args = ["docker", "exec", cid, "node", "--import", "tsx", "commerce-v2/src/foundation-storage-cli.ts", command]
        if command == "verify":
            marker = message["marker"]
            if not re.fullmatch(r"[0-9a-f-]{36}", marker):
                raise ValueError("MARKER_INVALID")
            args.append(marker)
        return json.loads(run(args))
    if operation == "archive":
        filename = message["filename"]
        if not re.fullmatch(target + r"-[0-9a-f]{40}-[0-9a-f-]{36}\.sqlite\.age", filename):
            raise ValueError("BACKUP_FILENAME_INVALID")
        directory = ROOT + "/backups/" + target
        os.makedirs(directory, mode=0o700, exist_ok=True)
        path = directory + "/" + filename
        run(["docker", "cp", cid + ":/var/lib/flexperiment-v2-backups/" + filename, path])
        os.chmod(path, 0o600)
        with open(path, "rb") as ciphertext:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: ciphertext.read(65536), b""):
                hasher.update(chunk)
            digest = hasher.hexdigest()
        return {"filename": filename, "sha256": digest, "size": os.stat(path).st_size, "custody": "owner_host_archive"}
    if operation == "record":
        directory = ROOT + "/evidence"
        os.makedirs(directory, mode=0o700, exist_ok=True)
        sha = message["proof"]["sourceCommit"]
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("SOURCE_INVALID")
        with open(directory + "/" + target + "-" + sha + ".json", "w", encoding="utf8") as output:
            os.chmod(output.name, 0o600)
            json.dump(message["proof"], output)
        return {"recorded": True}
    raise ValueError("OPERATION_REFUSED")


if __name__ == "__main__":
    try:
        os.umask(0o077)
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("INPUT_LIMIT")
        print(json.dumps(handle(json.loads(raw), private_json(ROOT + "/deploy-config.json"))))
    except ValueError as error:
        if str(error) == "V2_CONTAINER_NOT_CONVERGED" and json.loads(raw).get("operation") == "runtime":
            print(json.dumps({"pending": True}))
        else:
            print(json.dumps({"error": "V2_OWNER_OPERATION_REFUSED"}))
            sys.exit(1)
    except Exception:
        # No arbitrary API bodies, token, environment, URL or subprocess stderr.
        print(json.dumps({"error": "V2_OWNER_OPERATION_REFUSED"}))
        sys.exit(1)
