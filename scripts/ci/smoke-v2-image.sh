#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: smoke-v2-image.sh <image> <container-name> <container-port> <host-port> <service> [docker-run-args...]" >&2
  exit 64
fi

image=$1
container_name=$2
container_port=$3
host_port=$4
service=$5
shift 5

expected_commit=${SOURCE_COMMIT:?SOURCE_COMMIT is required}
identity_file=/app/.identity/identity.json
response_file=$(mktemp "${TMPDIR:-/tmp}/flexperiment-v2-smoke.XXXXXX")
headers_file=$(mktemp "${TMPDIR:-/tmp}/flexperiment-v2-smoke-headers.XXXXXX")

cleanup() {
  docker logs "$container_name" || true
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -f "$response_file" "$headers_file"
}
trap cleanup EXIT

docker run --detach --name "$container_name" --publish "127.0.0.1:${host_port}:${container_port}" "$@" "$image" >/dev/null

ready=false
for _ in $(seq 1 30); do
  if curl --fail-with-body --silent --show-error "http://127.0.0.1:${host_port}/readyz" >"$response_file"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ $ready != true ]]; then
  echo "${service} did not become ready" >&2
  if [[ -s $response_file ]]; then
    echo "last readiness response:" >&2
    cat "$response_file" >&2
    echo >&2
  fi
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:${host_port}/identity" >"$response_file"
node -e '
  const fs = require("node:fs");
  const [file, service, commit] = process.argv.slice(1);
  const identity = JSON.parse(fs.readFileSync(file, "utf8"));
  if (identity.schema !== "flexperiment.build-identity/1" || identity.service !== service || identity.sourceCommit !== commit) {
    throw new Error(`identity mismatch: ${JSON.stringify(identity)}`);
  }
' "$response_file" "$service" "$expected_commit"

test "$(docker exec "$container_name" stat -c '%a' "$identity_file")" = "444"
docker exec "$container_name" node -e '
  const fs = require("node:fs");
  const [file, service, commit] = process.argv.slice(1);
  const identity = JSON.parse(fs.readFileSync(file, "utf8"));
  if (identity.service !== service || identity.sourceCommit !== commit) process.exit(1);
' "$identity_file" "$service" "$expected_commit"

if [[ $service == platform ]]; then
  canonical_origin=${PLATFORM_CANONICAL_ORIGIN:?PLATFORM_CANONICAL_ORIGIN is required for the platform smoke}
  revalidate_token=${PLATFORM_REVALIDATE_TOKEN:?PLATFORM_REVALIDATE_TOKEN is required for the platform smoke}

  curl --fail --silent --show-error --dump-header "$headers_file" \
    "http://127.0.0.1:${host_port}/courses" >"$response_file"
  grep -q 'Каталог курсов' "$response_file"
  grep -q 'Первый курс готовится к публикации.' "$response_file"
  grep -q "${canonical_origin}" "$response_file"
  if grep -q 'https://build.invalid' "$response_file"; then
    echo "platform rendered output retained the image-build placeholder origin" >&2
    exit 1
  fi
  grep -Eiq '^content-security-policy:.*https://flexperiment\.s3\.cloud\.ru' "$headers_file"

  curl --fail --silent --show-error \
    "http://127.0.0.1:${host_port}/search-index.json" >"$response_file"
  node -e '
    const fs = require("node:fs");
    const documents = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(documents)) throw new Error("search index is not an array");
  ' "$response_file"

  curl --fail --silent --show-error \
    "http://127.0.0.1:${host_port}/sitemap.xml" >"$response_file"
  grep -q "${canonical_origin}/courses" "$response_file"

  for mode in swr immediate; do
    curl --fail --silent --show-error \
      --request POST \
      --header "Authorization: Bearer ${revalidate_token}" \
      --header 'Content-Type: application/json' \
      --data "{\"mode\":\"${mode}\",\"slug\":\"ci-rendered-smoke\"}" \
      "http://127.0.0.1:${host_port}/internal/revalidate" >"$response_file"
    node -e '
      const fs = require("node:fs");
      const [file, mode] = process.argv.slice(1);
      const result = JSON.parse(fs.readFileSync(file, "utf8"));
      if (result.revalidated !== true || result.mode !== mode) {
        throw new Error(`revalidation mismatch: ${JSON.stringify(result)}`);
      }
    ' "$response_file" "$mode"
  done

  curl --fail --silent --show-error \
    "http://127.0.0.1:${host_port}/courses" >"$response_file"
  grep -q 'Каталог курсов' "$response_file"
  grep -q 'Первый курс готовится к публикации.' "$response_file"
fi
