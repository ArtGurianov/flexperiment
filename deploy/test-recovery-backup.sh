#!/usr/bin/env bash
# Proves deploy/host/flexperiment-recovery-backup end to end without cloud.ru: the real script, the
# pinned rclone image, a stand-in Commerce container, S3 replaced by a local directory
# (FLEXPERIMENT_S3_LOCAL_DIR, the same rclone code path with an `alias` remote).
#
#   bash deploy/test-recovery-backup.sh
#
# Needs Docker. The script runs inside docker:cli (bash, age, python3, GNU find added) talking to the
# host's daemon, so every path it mounts must exist for the daemon at the same path: the work
# directory is created under this repository.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "$ROOT/.recovery-backup-test.XXXXXX")"
FAKE="commerce-rcltest$$-1"
cleanup() {
  docker rm -f "$FAKE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/conf" "$WORK/local" "$WORK/remote/art-backups/flexperiment/recovery/runtime"
REMOTE="$WORK/remote/art-backups/flexperiment/recovery/runtime"
printf 'test-access\n' > "$WORK/conf/s3-access-key"
printf 'test-secret\n' > "$WORK/conf/s3-secret-key"

RUNNER_IMAGE="flexperiment-recovery-backup-test"
docker build -q -t "$RUNNER_IMAGE" - >/dev/null <<'DOCKERFILE'
FROM docker:29-cli
RUN apk add --no-cache bash age python3 findutils coreutils
DOCKERFILE

run() {
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$WORK:$WORK" -v "$ROOT/deploy/host:/host:ro" \
    -e RECOVERY_DIR="$WORK/local" -e CONF_DIR="$WORK/conf" -e FLEXPERIMENT_S3_LOCAL_DIR="$WORK/remote" \
    "$RUNNER_IMAGE" bash -c "$1"
}

# A key pair: the recipient for the script, the identity to decrypt what it wrote.
run "age-keygen -o '$WORK/identity.txt' 2>/dev/null && age-keygen -y '$WORK/identity.txt' > '$WORK/conf/age-recipient.txt'"

docker run -d --name "$FAKE" \
  -e COMMERCE_TICKET_KEY_BASE64=dGVzdA== -e COMMERCE_EMAIL_HMAC_KEY=hmac -e COMMERCE_SESSION_SECRET=session \
  -e COMMERCE_ADMIN_PASSWORD_SCRYPT=scrypt -e TOCHKA_TERMINAL=t1 -e UNRELATED_SECRET=must-not-leave \
  -e SOURCE_COMMIT=0123456789abcdef0123456789abcdef01234567 node:22-alpine sleep 600 >/dev/null

failures=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; failures=$((failures + 1)); fi; }

# Retention fixtures: 105 older bundles in S3 plus an object the pattern does not name; 9 older local ones.
for i in $(seq -w 1 105); do printf 'old' > "$REMOTE/flexperiment-runtime-20250101T000${i:0:1}${i:1:2}Z.json.age"; done
printf 'keep' > "$REMOTE/README.txt"
for i in 1 2 3 4 5 6 7 8 9; do
  printf 'old' > "$WORK/local/flexperiment-runtime-2025010${i}T000000Z.json.age"
  touch -d "2025-01-0${i}T00:00:00" "$WORK/local/flexperiment-runtime-2025010${i}T000000Z.json.age"
done

echo
echo "flexperiment-recovery-backup (rclone, S3 as a local directory)"
echo
out="$(run '/host/flexperiment-recovery-backup' 2>&1)" || { echo "$out"; echo "  FAIL the script exited non-zero"; exit 1; }
name="$(printf '%s\n' "$out" | sed -n 's/^file=//p')"
check 'the run reports success' '[[ "$out" == *RECOVERY_BACKUP=SUCCESS* ]]'
check 'the bundle was uploaded' '[ -n "$name" ] && [ -s "$REMOTE/$name" ]'
# The backup writes root-owned 0600 files. Read their contents inside the test
# container, where the script itself runs as root, instead of the CI host user.
local_sha="$(run "sha256sum < '$WORK/local/$name'")"
remote_sha="$(run "sha256sum < '$REMOTE/$name'")"
check 'the uploaded object is byte-identical to the local bundle' \
  '[ "$remote_sha" = "$local_sha" ]'
plain="$(run "age -d -i '$WORK/identity.txt' '$WORK/local/$name'")"
check 'it decrypts with the recipient key to the recovery variables' \
  '[[ "$plain" == *COMMERCE_SESSION_SECRET* && "$plain" == *TOCHKA_TERMINAL* && "$plain" == *0123456789abcdef* ]]'
check 'variables outside the recovery set never leave the container' '[[ "$plain" != *UNRELATED_SECRET* ]]'
no_plaintext_status=0
run "grep -rl COMMERCE_SESSION_SECRET '$WORK/local' '$WORK/remote'" >/dev/null || no_plaintext_status=$?
check 'nothing readable is left on disk: only age files locally' '[ "$no_plaintext_status" = 1 ]'
check 'S3 keeps the 100 newest bundles' \
  '[ "$(ls "$REMOTE" | grep -c "^flexperiment-runtime-")" = 100 ] && [ -e "$REMOTE/$name" ]'
check 'the oldest S3 bundles were the ones removed' '[ ! -e "$REMOTE/flexperiment-runtime-20250101T000001Z.json.age" ]'
check 'S3 objects the pattern does not name are left alone' '[ -e "$REMOTE/README.txt" ]'
check 'the host keeps the 7 newest local bundles' \
  '[ "$(ls "$WORK/local" | grep -c "^flexperiment-runtime-")" = 7 ] && [ -e "$WORK/local/$name" ]'

# Without the S3 credentials, it refuses before touching anything.
rm "$WORK/conf/s3-secret-key"
check 'a missing credential file stops the run' '! run "/host/flexperiment-recovery-backup" >/dev/null 2>&1'

echo
if [ "$failures" -gt 0 ]; then echo "$failures failed"; exit 1; fi
echo "recovery backup: all checks passed"
