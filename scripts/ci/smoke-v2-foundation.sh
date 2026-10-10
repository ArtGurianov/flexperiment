#!/usr/bin/env bash
set -euo pipefail

image=${1:?image required}
expected=${SOURCE_COMMIT:?exact source required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || exit 1
task_dir=$(mktemp -d "${TMPDIR:-/tmp}/flex-v2-foundation.XXXXXX")
task_id="v2-foundation-smoke-$$"
data_volume="${task_id}-data"
backup_volume="${task_id}-backup"
cleanup() {
  docker rm -f "$task_id" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$backup_volume" >/dev/null 2>&1 || true
  rm -rf "$task_dir"
}
trap cleanup EXIT
age-keygen -o "$task_dir/synthetic.age.key" >/dev/null 2>&1
recipient=$(age-keygen -y "$task_dir/synthetic.age.key")
docker volume create "$data_volume" >/dev/null
docker volume create "$backup_volume" >/dev/null

start() {
  # No network: proves unavailable Refref fails closed without external CI calls.
  docker run -d --name "$task_id" --network none \
    --mount "type=volume,source=$data_volume,target=/var/lib/flexperiment-v2" \
    --mount "type=volume,source=$backup_volume,target=/var/lib/flexperiment-v2-backups" \
    --env COMMERCE_V2_FOUNDATION_MODE=true --env COMMERCE_V2_ENVIRONMENT=canary \
    --env DEPLOY_ENV=staging --env PAYMENT_MODE=disabled --env MARKETING_BROADCASTS_ENABLED=false \
    --env KINESCOPE_DELIVERY_MODE=open --env MERCHANT_PROMOTION_PREFIX=FX- \
    --env PLATFORM_SERVICE_TOKEN=ci-only-synthetic-service-token-not-a-secret \
    --env REFREF_READINESS_URL=https://canary-ops.refref.ru/readyz \
    --env COMMERCE_V2_BACKUP_PATH=/var/lib/flexperiment-v2-backups \
    --env "COMMERCE_V2_BACKUP_AGE_RECIPIENT=$recipient" "$image" >/dev/null
  for _ in $(seq 1 30); do
    if docker exec "$task_id" node -e 'fetch("http://127.0.0.1:3002/identity").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo FOUNDATION_BOOT_FAILED >&2
  exit 1
}
check() {
  docker exec "$task_id" node -e '
    const expected=process.argv[1];
    (async()=>{
      const identity=await (await fetch("http://127.0.0.1:3002/identity")).json();
      if(identity.sourceCommit!==expected||identity.service!=="commerce-v2")throw Error();
      const response=await fetch("http://127.0.0.1:3002/readyz");const ready=await response.json();
      if(response.status!==503||ready.ok!==false||ready.core.database!=="ok"||ready.core.paymentMode!=="disabled"||ready.capabilities.refref!=="unavailable"||ready.foundationMode!==true)throw Error();
      for(const path of ["/v1/checkout","/v1/auth/sign-in/magic-link","/v1/internal/course-manifests"]){
        const r=await fetch("http://127.0.0.1:3002"+path,{method:"POST"});
        if(r.status!==503||(await r.json()).error.code!=="FOUNDATION_ISOLATED")throw Error();
      }
    })().catch(()=>process.exit(1));
  ' "$expected"
  [[ $(docker exec "$task_id" stat -c '%a' /app/.identity/identity.json) == 444 ]]
  docker exec "$task_id" sh -c 'test ! -w /app/.identity/identity.json && test ! -w /app/.identity && test ! -w /app'
}
storage() { docker exec "$task_id" node --import tsx commerce-v2/src/foundation-storage-cli.ts "$@"; }
start
check
marker=$(storage mark | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).marker))')
storage backup > "$task_dir/proof.json"
filename=$(node -e 'process.stdout.write(require(process.argv[1]).filename)' "$task_dir/proof.json")
docker cp "$task_id:/var/lib/flexperiment-v2-backups/$filename" "$task_dir/backup.age" >/dev/null
age -d -i "$task_dir/synthetic.age.key" -o "$task_dir/restored.sqlite" "$task_dir/backup.age"
docker cp "$task_dir/restored.sqlite" "$task_id:/tmp/restored.sqlite" >/dev/null
docker exec --user 0 "$task_id" chown node:node /tmp/restored.sqlite
docker exec --user 0 "$task_id" chmod 0600 /tmp/restored.sqlite
docker exec "$task_id" node -e '
  const db=new (require("better-sqlite3"))("/tmp/restored.sqlite",{readonly:true});
  const row=db.prepare("SELECT environment,source_commit FROM deployment_durability WHERE id=?").get(process.argv[1]);
  if(db.pragma("quick_check",{simple:true})!=="ok"||row?.environment!=="canary"||row?.source_commit!==process.argv[2])process.exit(1);
  db.close();
' "$marker" "$expected"
docker restart "$task_id" >/dev/null
for _ in $(seq 1 30); do if storage verify "$marker" >/dev/null 2>&1; then break; fi; sleep 1; done
storage verify "$marker"
docker rm -f "$task_id" >/dev/null
start
check
storage verify "$marker"
echo 'FOUNDATION_IMAGE=PASS persistence=PASS encrypted_restore=PASS refref_unavailable_fail_closed=PASS'
