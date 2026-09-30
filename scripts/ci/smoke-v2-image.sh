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

cleanup() {
  docker logs "$container_name" || true
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -f "$response_file"
}
trap cleanup EXIT

docker run --detach --name "$container_name" --publish "127.0.0.1:${host_port}:${container_port}" "$@" "$image" >/dev/null

ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error "http://127.0.0.1:${host_port}/readyz" >"$response_file"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ $ready != true ]]; then
  echo "${service} did not become ready" >&2
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
