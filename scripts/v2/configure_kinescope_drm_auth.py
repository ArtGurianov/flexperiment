#!/usr/bin/env python3
"""Project-scoped Kinescope DRM PUT with hidden credentials and redacted output.

Run only after ART-336's live callback and ingress admission checks pass.
The script deliberately has no workspace endpoint and never logs response bodies.
"""

import argparse
import base64
import getpass
import json
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.request


PROJECT_ID = "6964ab60-0ba1-4738-82d2-eada67792e0b"
CALLBACK = "https://canary-api.flexperiment.ru/v1/kinescope/drm/authorize"
API_URL = f"https://api.kinescope.io/v1/drm/auth/{PROJECT_ID}"
OWNER_ROOT = Path("/root/flexperiment-v2-owner/kinescope")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def request_status(opener, request):
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read(65536)
        finally:
            error.close()


def owner_credentials():
    directory = OWNER_ROOT.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or stat.S_IMODE(directory.st_mode) != 0o700:
        raise SystemExit("Owner secret directory invalid; no provider mutation")

    def read(path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise SystemExit("Owner secret file invalid; no provider mutation")
        return path.read_text().strip()

    data = json.loads(read(OWNER_ROOT / "drm-credentials.json"))
    return data["username"], data["password"], read(OWNER_ROOT / "api-token")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform one project-scoped PUT")
    parser.add_argument("--owner-files", action="store_true", help="read fixed root-owned VPS secret files")
    args = parser.parse_args()
    if not args.apply:
        parser.error("provide --apply after the callback and proxy preflight passes")

    if args.owner_files:
        username, password, token = owner_credentials()
    else:
        username = getpass.getpass("Canary DRM Basic username (hidden): ")
        password = getpass.getpass("Canary DRM Basic password (hidden): ")
        token = getpass.getpass("Kinescope API token (hidden): ")
    if not username or not password or not token or any("\n" in item or "\r" in item for item in (username, password, token)):
        raise SystemExit("Missing or malformed credential; no provider mutation")

    opener = urllib.request.build_opener(NoRedirect)
    basic = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
    callback_request = urllib.request.Request(
        CALLBACK,
        data=b'{"id":"preflight","type":"video","token":""}',
        headers={"Authorization": f"Basic {basic}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        callback_status, _ = request_status(opener, callback_request)
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"Callback unreachable ({type(error).__name__}); no provider mutation") from None
    print(f"callback_http={callback_status}")
    if callback_status != 400:
        raise SystemExit("Expected authenticated malformed-payload 400; no provider mutation")

    payload = json.dumps({"url": CALLBACK, "username": username, "password": password, "strict": True}).encode()
    put_request = urllib.request.Request(
        API_URL,
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
    )
    try:
        put_status, _ = request_status(opener, put_request)
    except (urllib.error.URLError, TimeoutError) as error:
        raise SystemExit(f"PUT outcome unknown ({type(error).__name__}); use GET read-back before retry") from None
    print(f"project_put_http={put_status}")
    if put_status not in (200, 201, 204):
        raise SystemExit("PUT did not return success; inspect provider securely; no blind retry")

    get_request = urllib.request.Request(API_URL, headers={"Authorization": f"Bearer {token}"}, method="GET")
    try:
        get_status, raw = request_status(opener, get_request)
        data = json.loads(raw) if raw else {}
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise SystemExit(f"GET read-back inconclusive ({type(error).__name__}); do not retry PUT blindly") from None
    config = data.get("data") if isinstance(data, dict) else None
    if not isinstance(config, dict):
        config = data if isinstance(data, dict) else {}
    verified = get_status == 200 and config.get("url") == CALLBACK and config.get("strict") is True
    print(f"project_get_http={get_status} callback_host={'canary-api.flexperiment.ru' if config.get('url') == CALLBACK else 'unexpected'} strict={config.get('strict') is True}")
    if not verified:
        raise SystemExit("GET did not verify expected project URL and strict=true")
    print("PROJECT_DRM_AUTH_CONFIGURED")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Interrupted; check project GET before any retry")
