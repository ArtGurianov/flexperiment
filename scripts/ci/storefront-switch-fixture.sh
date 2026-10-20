#!/usr/bin/env bash
# ART-319 on the actual Commerce image: the owner's storefront switch and its journal reach the
# runtime only as root-owned files in two read-only mounts, the runtime user cannot change either,
# and a switch file that is not what the journal last recorded is CLOSED. Isolated CI volumes only;
# no host path, no production configuration, no network.
storefront_switch_fixture_create() {
  local fixture_image=$1 switch_volume=$2 journal_volume=$3
  docker volume create "$switch_volume" >/dev/null
  docker volume create "$journal_volume" >/dev/null
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=volume,source=$switch_volume,target=/host-switch" \
    --mount "type=volume,source=$journal_volume,target=/host-journal" "$fixture_image" -e '
    const fs=require("node:fs"),crypto=require("node:crypto");
    const doc=(generation,courses)=>JSON.stringify({schema:"flexperiment.storefront-switch/1",scope:"canary",generation,
      changedAt:"2026-10-19T09:00:00.000Z",changedBy:"ci",reason:"isolated CI fixture",evidenceIssue:"ART-319",
      storefronts:{COURSES:courses,LAB:{state:"CLOSED"}}});
    const open=doc(1,{state:"OPEN",openSince:1}),stop=doc(2,{state:"CLOSED"});
    const record=(raw)=>JSON.stringify({generation:JSON.parse(raw).generation,sha256:crypto.createHash("sha256").update(raw).digest("hex")})+"\n";
    fs.writeFileSync("/host-journal/journal.jsonl",record(open),{flag:"wx",mode:0o444});
    fs.writeFileSync("/host-switch/switch.json",open,{flag:"wx",mode:0o444});
    // Kept beside the volumes for the restore scenario below; never mounted into the runtime.
    fs.writeFileSync("/host-switch/.stop",stop,{flag:"wx",mode:0o400});
    fs.chmodSync("/host-switch",0o555);fs.chmodSync("/host-journal",0o555);
  '
}

storefront_switch_fixture_assert() {
  local fixture_image=$1 switch_volume=$2 journal_volume=$3 switch_mode=$4 journal_mode=$5 expected=$6
  local mount_args=() volume mode target
  for spec in "$switch_volume:$switch_mode:/etc/flexperiment-sales" "$journal_volume:$journal_mode:/etc/flexperiment-sales-journal"; do
    IFS=: read -r volume mode target <<<"$spec"
    [[ "$mode" != none ]] || continue
    local fixture_mount="type=volume,source=$volume,target=$target"
    [[ "$mode" != readonly ]] || fixture_mount+=",readonly"
    mount_args+=(--mount "$fixture_mount")
  done
  docker run --rm --network none --entrypoint node "${mount_args[@]}" --env DEPLOY_ENV=staging "$fixture_image" \
    --import tsx --input-type=module -e '
    import Database from "better-sqlite3";
    import fs from "node:fs";
    import { migrateV2 } from "./commerce-v2/src/db.ts";
    import { hostStorefrontSwitchSource, readStorefrontSwitch } from "./commerce-v2/src/storefront-switch.ts";
    const expected = process.argv[1];
    const db = new Database(":memory:"); migrateV2(db);
    const reading = readStorefrontSwitch(db, { deployEnvironment: "staging", storefrontSwitch: hostStorefrontSwitchSource() });
    const seen = reading.available ? reading.document.storefronts.COURSES.state : reading.reason;
    if (seen !== expected) throw Error("STOREFRONT_SWITCH_IMAGE_ASSERTION_FAILED:" + seen);
    if (process.getuid() === 0) throw Error("STOREFRONT_SWITCH_RUNTIME_IS_ROOT");
    for (const [dir, file] of [["/etc/flexperiment-sales", "switch.json"], ["/etc/flexperiment-sales-journal", "journal.jsonl"]]) {
      if (!fs.existsSync(dir)) continue;
      for (const attempt of [
        () => fs.writeFileSync(`${dir}/${file}`, "{}"),
        () => fs.appendFileSync(`${dir}/${file}`, "{}\n"),
        () => fs.writeFileSync(`${dir}/next`, "{}"),
        () => fs.renameSync(`${dir}/${file}`, `${dir}/old`),
        () => fs.unlinkSync(`${dir}/${file}`),
      ]) {
        let written = true;
        try { attempt(); } catch { written = false; }
        if (written) throw Error("STOREFRONT_SWITCH_WRITABLE_BY_RUNTIME:" + dir);
      }
    }
  ' "$expected"
}

storefront_switch_image_checks() {
  local fixture_image=$1 fixture_prefix=$2
  local switch_volume="${fixture_prefix}-storefront-switch" journal_volume="${fixture_prefix}-storefront-journal"
  storefront_switch_fixture_create "$fixture_image" "$switch_volume" "$journal_volume"
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" readonly readonly OPEN
  # A writable mount, or a missing one (reboot before mount, image default), is CLOSED.
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" writable readonly UNREADABLE
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" readonly writable UNREADABLE
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" none readonly UNREADABLE
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" readonly none UNREADABLE
  # The owner stops at generation 2 (journal first), then a restore puts the generation 1 OPEN file
  # back: the journal still ends at 2, so the runtime refuses it (review P1-1).
  docker run --rm --network none --user 0 --entrypoint node \
    --mount "type=volume,source=$switch_volume,target=/host-switch" \
    --mount "type=volume,source=$journal_volume,target=/host-journal" "$fixture_image" -e '
    const fs=require("node:fs"),crypto=require("node:crypto");
    const stop=fs.readFileSync("/host-switch/.stop");
    fs.appendFileSync("/host-journal/journal.jsonl",JSON.stringify({generation:2,sha256:crypto.createHash("sha256").update(stop).digest("hex")})+"\n");
  '
  storefront_switch_fixture_assert "$fixture_image" "$switch_volume" "$journal_volume" readonly readonly JOURNAL_MISMATCH
  docker volume rm "$switch_volume" "$journal_volume" >/dev/null 2>&1 || true
  echo 'STOREFRONT_SWITCH_IMAGE=PASS read_only_mounts=OPEN writable_or_missing_mount=CLOSED restored_open_over_stop=CLOSED runtime_writer=NONE'
}
