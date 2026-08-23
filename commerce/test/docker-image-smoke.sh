#!/usr/bin/env bash
set -euo pipefail

# This is intentionally an image-level check: TypeScript/tests run from the
# full checkout and cannot prove that Docker copied root shared modules needed
# by Commerce runtime imports.
IMAGE_TAG="${1:-flexperiment-commerce-smoke:local}"
CONTAINER_NAME="flexperiment-commerce-smoke-$$"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build -f Dockerfile.commerce -t "$IMAGE_TAG" .
docker run --rm --entrypoint sh "$IMAGE_TAG" -c 'test -f /app/lib/city-catalog.ts'

docker run -d --name "$CONTAINER_NAME" \
  -e COMMERCE_PROVIDER=mock \
  -e COMMERCE_EMAIL_PROVIDER=mock \
  -e COMMERCE_DATABASE_PATH=/tmp/commerce.sqlite \
  -e COMMERCE_SESSION_SECRET=commerce-image-smoke-session-secret \
  -e HOST=127.0.0.1 \
  "$IMAGE_TAG" >/dev/null

for _ in $(seq 1 40); do
  if docker exec "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:3001/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
    echo "Commerce image startup smoke: OK"
    exit 0
  fi
  sleep 0.25
done

docker logs "$CONTAINER_NAME" >&2
echo "Commerce image startup smoke: FAILED" >&2
exit 1
