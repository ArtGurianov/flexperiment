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
# Safety: a directory is removed only when all three hold.
#   1. its name has the mkdtemp shape: lowercase-dashed prefix + random suffix;
#   2. it is older than the age threshold, so a concurrent run is untouched;
#   3. it contains nothing but SQLite files (or is empty).
# The third rule is what makes this safe to point at a shared TMPDIR: another
# tool's directory of the same shape holds other content and is skipped.

older_than_hours="${TEST_TEMP_GC_HOURS:-12}"
dry_run=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --older-than-hours) older_than_hours="${2:?--older-than-hours needs a value}"; shift 2 ;;
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

# A nested directory does not match any pattern below, so it also means skip.
only_sqlite_inside() {
  local directory="$1" entry result=0
  shopt -s nullglob dotglob
  for entry in "$directory"/*; do
    case "${entry##*/}" in
      *.sqlite|*.sqlite-wal|*.sqlite-shm|*.sqlite-journal|*.db) ;;
      *) result=1; break ;;
    esac
  done
  shopt -u nullglob dotglob
  return "$result"
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

examined=0 removed=0 skipped=0 reclaimed_kb=0
while IFS= read -r directory; do
  [[ -z "$directory" ]] && continue
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
done < <("${find_prefix[@]}" -type d -mmin "+${minutes}" -regex "$shape")

printf '%s %d of %d fixture directories older than %dh under %s (%d skipped: foreign content), ~%d MiB\n' \
  "$( ((dry_run)) && echo 'Would remove' || echo 'Removed' )" \
  "$removed" "$examined" "$older_than_hours" "$root" "$skipped" "$((reclaimed_kb / 1024))"
