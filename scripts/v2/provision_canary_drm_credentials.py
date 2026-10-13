#!/usr/bin/env python3
"""Provision canary-only Commerce DRM credentials in Coolify, without deploying.

Runs on the owner VPS. Values stay in a root-owned file and runtime-only Coolify
environment rows. A partial API failure can be reconciled by rerunning this
script; existing values must match exactly or it refuses.
"""

import argparse
import json
import os
from pathlib import Path
import secrets
import stat
import urllib.error
import urllib.request
import uuid as uuidlib


ROOT = Path("/root/flexperiment-v2-owner")
SECRET_DIR = ROOT / "kinescope"
SECRET_FILE = SECRET_DIR / "drm-credentials.json"
SOURCE = "84b1a6abcb43e9abf8f781e830f84822207c0dca"
APP_UUID = "xzuy7pk5y6ywjr9kh6nsk5ap"
BASE = "https://coolify.refref.ru/api/v1"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def private_bytes(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise RuntimeError("OWNER_SECRET_PERMISSIONS_INVALID")
    return path.read_bytes()


def api(opener, token, method, path, body=None):
    request = urllib.request.Request(
        BASE + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    with opener.open(request, timeout=20) as response:
        if response.status not in (200, 201):
            raise RuntimeError("CONTROL_STATUS_REFUSED")
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise RuntimeError("CONTROL_RESPONSE_LIMIT")
        return json.loads(raw)


def actual_value(row):
    return row.get("value") if row.get("is_literal") else row.get("real_value", row.get("value"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        parser.error("provide --apply for the owner-approved canary mutation")

    config = json.loads(private_bytes(ROOT / "deploy-config.json"))
    if config.get("apps", {}).get("canary") != APP_UUID or config.get("apps", {}).get("production") == APP_UUID:
        raise RuntimeError("CANARY_APP_IDENTITY_REFUSED")
    provider_token = private_bytes(SECRET_DIR / "api-token").decode().strip()
    if len(provider_token) != 36 or str(uuidlib.UUID(provider_token)) != provider_token:
        raise RuntimeError("KINESCOPE_TOKEN_FORMAT_REFUSED")
    control_token = private_bytes(ROOT / "coolify-api.token").decode().strip()
    opener = urllib.request.build_opener(NoRedirect)
    app = api(opener, control_token, "GET", f"/applications/{APP_UUID}")
    if app.get("uuid") != APP_UUID or app.get("git_commit_sha") != SOURCE or app.get("fqdn") \
            or app.get("name") != "flexperiment-commerce-v2-canary" or app.get("settings", {}).get("is_auto_deploy_enabled") is not False:
        raise RuntimeError("CANARY_SOURCE_OR_ISOLATION_REFUSED")
    path = f"/applications/{APP_UUID}/envs"
    rows = api(opener, control_token, "GET", path)
    for key, expected in {"PAYMENT_MODE": "disabled", "MARKETING_BROADCASTS_ENABLED": "false",
                          "KINESCOPE_DELIVERY_MODE": "open", "SOURCE_COMMIT": SOURCE}.items():
        matches = [row for row in rows if row.get("key") == key and not row.get("is_preview")]
        if len(matches) != 1 or actual_value(matches[0]) != expected:
            raise RuntimeError("CANARY_ENVIRONMENT_REFUSED")

    directory = SECRET_DIR.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise RuntimeError("OWNER_SECRET_DIRECTORY_INVALID")
    if SECRET_FILE.exists():
        credentials = json.loads(private_bytes(SECRET_FILE))
        if set(credentials) == {"username", "password"}:
            # Setup already completed: the signing key has been removed from
            # owner staging custody. Never mint or overwrite it on a rerun.
            expected = {"KINESCOPE_DRM_USERNAME": credentials["username"],
                        "KINESCOPE_DRM_PASSWORD": credentials["password"]}
            for key, value in expected.items():
                matches = [row for row in rows if row.get("key") == key]
                if len(matches) != 1 or matches[0].get("is_preview") is not False \
                        or actual_value(matches[0]) != value or matches[0].get("is_runtime") is not True \
                        or matches[0].get("is_buildtime") is not False:
                    raise RuntimeError("DRM_ENVIRONMENT_CONFLICT")
            signing = [row for row in rows if row.get("key") == "KINESCOPE_DRM_TOKEN_SECRET"]
            if len(signing) != 1 or signing[0].get("is_preview") is not False \
                    or signing[0].get("is_runtime") is not True or signing[0].get("is_buildtime") is not False \
                    or len(actual_value(signing[0]) or "") < 32:
                raise RuntimeError("DRM_SIGNING_ENVIRONMENT_CONFLICT")
            print("CANARY_DRM_CREDENTIALS_SAVED")
            return
    else:
        credentials = {"username": "drm_canary_" + secrets.token_hex(8),
                       "password": secrets.token_urlsafe(48), "signingSecret": secrets.token_urlsafe(48)}
        descriptor = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w") as output:
                json.dump(credentials, output)
                output.flush()
                os.fsync(output.fileno())
        finally:
            descriptor = -1
        directory_fd = os.open(SECRET_DIR, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    if set(credentials) != {"username", "password", "signingSecret"} \
            or any(not isinstance(value, str) or len(value) < 32 for key, value in credentials.items() if key != "username"):
        raise RuntimeError("DRM_CREDENTIALS_INVALID")

    desired = {"KINESCOPE_DRM_USERNAME": credentials["username"],
               "KINESCOPE_DRM_PASSWORD": credentials["password"],
               "KINESCOPE_DRM_TOKEN_SECRET": credentials["signingSecret"]}
    for key, value in desired.items():
        rows = api(opener, control_token, "GET", path)
        main_rows = [row for row in rows if row.get("key") == key and row.get("is_preview") is False]
        preview_rows = [row for row in rows if row.get("key") == key and row.get("is_preview") is True]
        if len(main_rows) > 1 or len(preview_rows) > 1 or main_rows and (actual_value(main_rows[0]) != value
              or main_rows[0].get("is_buildtime") is not False or main_rows[0].get("is_runtime") is not True):
            raise RuntimeError("DRM_ENVIRONMENT_CONFLICT")
        if not main_rows:
            api(opener, control_token, "POST", path, {"key": key, "value": value,
                "is_preview": False, "is_buildtime": False, "is_runtime": True})
        # Coolify 4.4.6 mirrors API-created env rows into preview despite
        # is_preview=false. Remove only this key's exact mirrored row.
        rows = api(opener, control_token, "GET", path)
        preview_rows = [row for row in rows if row.get("key") == key and row.get("is_preview") is True]
        if len(preview_rows) > 1 or preview_rows and (actual_value(preview_rows[0]) != value
              or preview_rows[0].get("is_buildtime") is not False
              or preview_rows[0].get("is_runtime") is not True
              or not isinstance(preview_rows[0].get("uuid"), str)):
            raise RuntimeError("DRM_PREVIEW_ENVIRONMENT_CONFLICT")
        if preview_rows:
            api(opener, control_token, "DELETE", path + "/" + preview_rows[0]["uuid"])
        print(f"{key}=stored")
    rows = api(opener, control_token, "GET", path)
    if any(len([row for row in rows if row.get("key") == key and row.get("is_preview") is False
                and actual_value(row) == value and row.get("is_buildtime") is False
                and row.get("is_runtime") is True]) != 1 for key, value in desired.items()):
        raise RuntimeError("DRM_ENVIRONMENT_READBACK_REFUSED")
    if any(row.get("key") in desired and row.get("is_preview") is True for row in rows):
        raise RuntimeError("DRM_PREVIEW_ENVIRONMENT_READBACK_REFUSED")
    # Playback signing keys belong only to Commerce runtime secrets. Keep the
    # Basic pair for Kinescope project configuration; remove the staging copy.
    basic_file = SECRET_DIR / ".drm-basic-credentials.next"
    descriptor = os.open(basic_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump({"username": credentials["username"], "password": credentials["password"]}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(basic_file, SECRET_FILE)
    directory_fd = os.open(SECRET_DIR, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    print("CANARY_DRM_CREDENTIALS_SAVED")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, urllib.error.URLError, OSError) as error:
        print(error.args[0] if isinstance(error, RuntimeError) and str(error).isupper() else "CANARY_DRM_PROVISION_REFUSED")
        raise SystemExit(1) from None
