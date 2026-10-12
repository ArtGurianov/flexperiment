#!/usr/bin/env bash
# Isolated CI-only host custody. No production path/volume/configuration writes.
# No installation record is copied into a runtime image.
erasure_fixture_create() {
  local fixture_image=$1 fixture_volume=$2 fixture_state=${3:-NEVER_INSTALLED}
  docker volume create "$fixture_volume" >/dev/null
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=volume,source=$fixture_volume,target=/host-admission" "$fixture_image" -e '
    const fs=require("node:fs"),crypto=require("node:crypto");
    const state=process.argv[1];
    if(!["NEVER_INSTALLED","REQUIRED"].includes(state))throw Error("INVALID_FIXTURE");
    fs.writeFileSync("/host-admission/installation.json",JSON.stringify({version:1,
      installationId:crypto.randomUUID(),scope:"canary",state,
      ...(state==="REQUIRED"?{fenceDirectory:"/fixture/fence"}:{})}),{flag:"wx",mode:0o444});
    fs.chmodSync("/host-admission",0o555);
  ' "$fixture_state"
}

erasure_fixture_assert() {
  local fixture_image=$1 fixture_volume=$2 expected_code=$3 enabled=$4 mount_mode=${5:-readonly}
  local fixture_mount="type=volume,source=$fixture_volume,target=/etc/flexperiment-erasure"
  [[ "$mount_mode" != readonly ]] || fixture_mount+=",readonly"
  local fixture_env=()
  [[ "$enabled" == missing ]] || fixture_env+=(--env "ERASURE_FENCING_ENABLED=$enabled")
  docker run --rm --network none --entrypoint node --mount "$fixture_mount" \
    --env DEPLOY_ENV=staging "${fixture_env[@]}" "$fixture_image" --import tsx --input-type=module -e '
    import {prepareErasureRuntime} from "./commerce-v2/src/erasure-runtime.ts";
    import {assertFoundationErasureAdmission} from "./commerce-v2/src/erasure-installation.ts";
    import fs from "node:fs";
    const expected=process.argv[1];let code="LEGACY_ALLOWED";
    try {
      if(expected==="ERASURE_INSTALLED_FOUNDATION_START_FORBIDDEN")assertFoundationErasureAdmission(process.env);
      else await prepareErasureRuntime({db:{},environment:process.env,forbiddenRoots:["/merchant"]});
    }catch(error){code=error.code??error.message;}
    if(code!==expected)throw Error("ERASURE_IMAGE_ADMISSION_ASSERTION_FAILED:"+code);
    let protectedFile=false;
    try{fs.writeFileSync("/etc/flexperiment-erasure/installation.json","{}");}catch{protectedFile=true;}
    if(!protectedFile)throw Error("ERASURE_HOST_RECORD_WRITABLE");
  ' "$expected_code"
}

erasure_fixture_image_checks() {
  local fixture_image=$1 fixture_prefix=$2
  local legacy="${fixture_prefix}-legacy" installed="${fixture_prefix}-installed"
  erasure_fixture_create "$fixture_image" "$legacy" NEVER_INSTALLED
  erasure_fixture_create "$fixture_image" "$installed" REQUIRED
  # Existing actual-image CI also proves the kernel RO mount for library read
  # files. This fixture contains NO real credentials and makes NO cloud call.
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=volume,source=$installed,target=/host-admission" "$fixture_image" -e '
    const fs=require("node:fs");
    fs.writeFileSync("/host-admission/reader.json",JSON.stringify({fixture:"READ_ONLY"}),{flag:"wx",mode:0o600});
    fs.chownSync("/host-admission/reader.json",1000,1000);
  '
  for mount_mode in readonly writable; do
    local reader_mount="type=volume,source=$installed,target=/etc/erasure-reader"
    [[ "$mount_mode" != readonly ]] || reader_mount+=",readonly"
    docker run --rm --network none --entrypoint node --mount "$reader_mount" "$fixture_image" --import tsx --input-type=module -e '
    import {readErasureReaderFile} from "./commerce-v2/src/erasure-library-read.ts";
    let ok=false;try{ok=readErasureReaderFile("/etc/erasure-reader/reader.json",["/app"]).fixture==="READ_ONLY";}catch{}
    if(ok!==(process.argv[1]==="readonly"))throw Error("ERASURE_LIBRARY_RO_MOUNT_ASSERTION_FAILED");
    ' "$mount_mode"
  done
  for flag in false missing; do
    erasure_fixture_assert "$fixture_image" "$legacy" LEGACY_ALLOWED "$flag"
    erasure_fixture_assert "$fixture_image" "$installed" ERASURE_INSTALLATION_DOWNGRADE_REFUSED "$flag"
    erasure_fixture_assert "$fixture_image" "$installed" ERASURE_INSTALLED_FOUNDATION_START_FORBIDDEN "$flag"
  done
  erasure_fixture_assert "$fixture_image" "$legacy" ERASURE_INSTALLATION_NOT_ADMITTED true
  erasure_fixture_assert "$fixture_image" "$legacy" ERASURE_INSTALLATION_EVIDENCE_INVALID false writable
  # Removing the host evidence does not become an implicit legacy initialization.
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=volume,source=$installed,target=/host-admission" "$fixture_image" -e '
    require("node:fs").unlinkSync("/host-admission/installation.json");'
  erasure_fixture_assert "$fixture_image" "$installed" ERASURE_INSTALLATION_EVIDENCE_INVALID false
  echo 'ERASURE_INSTALLATION_IMAGE=PASS legacy_admission=EXPLICIT downgrade=REFUSED missing_evidence=CLOSED root_owned_ro_mount=PASS'
}
