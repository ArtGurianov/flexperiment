#!/usr/bin/env bash
set -euo pipefail

# Reclaims the SQLite fixture directories the test suite leaves in TMPDIR.
#
# This is not only a wedged-runner guard. A single *successful* full-suite run
# leaves roughly 4 GB behind, because each fixture builds its own ~1.6 MB
# database under mkdtemp and not every test removes it. On 2026-09-13 an
# orphaned Vitest process (alive four days, so its cleanup never ran) combined
# with that ordinary leak to reach 228 GB across 139k directories and fill the
# volume, which then produced misleading ENOSPC "test failures".
#
# Deliberately NOT wired into Vitest's own lifecycle: a runner that wedges is
# exactly the one that will not run its cleanup hook. Run it from the outside -
# `pnpm test:temp:gc` - before or after a full suite.
#
# Safety: ownership is proved, not inferred. A directory is removed only when
# all three hold.
#   1. its name is exactly <prefix>-<random suffix> for a prefix listed in
#      scripts/test-temp-prefixes.txt - this repo's own mkdtemp prefixes;
#   2. it is older than the age threshold, so a concurrent run is untouched;
#   3. every entry inside is a regular SQLite file (or it is empty).
# Rule 1 is what makes a shared TMPDIR safe. Shape plus contents is not enough:
# a foreign `other-tool-Ab12Cd/state.db` satisfies both and is not ours.

older_than_hours="${TEST_TEMP_GC_HOURS:-12}"
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --older-than-hours)
      [[ -n "${2:-}" ]] || { echo "TEST_TEMP_GC_MISSING_VALUE: --older-than-hours" >&2; exit 2; }
      older_than_hours="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --) shift ;;   # `pnpm run test:temp:gc -- --flag` forwards this separator
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "TEST_TEMP_GC_UNKNOWN_ARGUMENT: $1" >&2; exit 2 ;;
  esac
done
[[ "$older_than_hours" =~ ^[0-9]+$ ]] || { echo "TEST_TEMP_GC_INVALID_AGE: $older_than_hours" >&2; exit 2; }

root="${TEST_TEMP_GC_ROOT:-${TMPDIR:-/tmp}}"
root="${root%/}"
[[ -d "$root" ]] || { echo "TEST_TEMP_GC_ROOT_MISSING: $root" >&2; exit 2; }

# Fixtures land in TMPDIR, which on macOS is /var/folders/../T - not /tmp.
shape='.*/[a-z][a-z0-9]*(-[a-z0-9]+)*-[A-Za-z0-9]{6,10}'
minutes=$((older_than_hours * 60))

# Regular files only: a directory named `cache.sqlite/` matches the name
# patterns but is not a database, so the -f test is load-bearing.
only_sqlite_inside() {
  local directory="$1" entry result=0
  shopt -s nullglob dotglob
  for entry in "$directory"/*; do
    if [[ ! -f "$entry" ]]; then result=1; break; fi
    case "${entry##*/}" in
      *.sqlite|*.sqlite-wal|*.sqlite-shm|*.sqlite-journal|*.db) ;;
      *) result=1; break ;;
    esac
  done
  shopt -u nullglob dotglob
  return "$result"
}

prefix_file="${TEST_TEMP_GC_PREFIXES:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-temp-prefixes.txt}"
[[ -f "$prefix_file" ]] || { echo "TEST_TEMP_GC_PREFIX_FILE_MISSING: $prefix_file" >&2; exit 2; }
owned_prefixes=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  owned_prefixes+=("$line")
done < "$prefix_file"
(( ${#owned_prefixes[@]} )) || { echo "TEST_TEMP_GC_PREFIX_FILE_EMPTY: $prefix_file" >&2; exit 2; }

# Exactly <owned prefix>-<random suffix>, never a prefix-of match.
is_owned() {
  local name="$1" prefix
  [[ "$name" =~ ^(.+)-[A-Za-z0-9]{6,10}$ ]] || return 1
  for prefix in "${owned_prefixes[@]}"; do
    [[ "${BASH_REMATCH[1]}" == "$prefix" ]] && return 0
  done
  return 1
}

# BSD find spells extended regex `find -E`; GNU find wants
# `-regextype posix-extended` before -regex. Getting this wrong is silent:
# GNU find without it treats the pattern as emacs regex and simply matches
# nothing, which is how the first version of this script became a no-op on CI
# while passing locally. Probe rather than assume, and fail loudly either way.
if find -E . -maxdepth 0 -regex '.*' >/dev/null 2>&1; then
  find_prefix=(find -E "$root" -maxdepth 1)
else
  find_prefix=(find "$root" -maxdepth 1 -regextype posix-extended)
fi

# Materialised rather than piped: a process substitution's exit status never
# reaches the script, so a find that fails for any reason - permissions, a
# flavour mismatch, anything - would print to stderr and still leave the loop
# with nothing to do, reporting a cheerful "Removed 0 of 0" and exiting 0.
# That is the same silent no-op this script exists to prevent.
candidates="$(mktemp "${TMPDIR:-/tmp}/test-temp-gc.XXXXXX")"
trap 'rm -f "$candidates"' EXIT
# Capture the status rather than testing with `!`: inside `if ! cmd; then`,
# $? is the status of the negation, which is always 0 - so the diagnostic
# would have reported "find exited 0" for every real failure.
scan_status=0
"${find_prefix[@]}" -type d -mmin "+${minutes}" -regex "$shape" > "$candidates" || scan_status=$?
if (( scan_status != 0 )); then
  echo "TEST_TEMP_GC_SCAN_FAILED: find exited $scan_status while scanning $root" >&2
  exit 2
fi

examined=0 removed=0 skipped=0 foreign=0 reclaimed_kb=0
while IFS= read -r directory; do
  [[ -z "$directory" ]] && continue
  if ! is_owned "$(basename "$directory")"; then foreign=$((foreign + 1)); continue; fi
  examined=$((examined + 1))
  if ! only_sqlite_inside "$directory"; then skipped=$((skipped + 1)); continue; fi
  size_kb="$(du -skx "$directory" 2>/dev/null | awk '{print $1}')"
  if (( dry_run )); then
    removed=$((removed + 1)); reclaimed_kb=$((reclaimed_kb + ${size_kb:-0}))
    continue
  fi
  if rm -rf "$directory" 2>/dev/null; then
    removed=$((removed + 1)); reclaimed_kb=$((reclaimed_kb + ${size_kb:-0}))
  else
    skipped=$((skipped + 1))
  fi
done < "$candidates"

printf '%s %d of %d owned fixture directories older than %dh under %s (%d skipped: unexpected content, %d not ours), ~%d MiB\n' \
  "$( ((dry_run)) && echo 'Would remove' || echo 'Removed' )" \
  "$removed" "$examined" "$older_than_hours" "$root" "$skipped" "$foreign" "$((reclaimed_kb / 1024))"
