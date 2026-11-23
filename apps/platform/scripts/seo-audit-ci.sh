#!/usr/bin/env bash
# FLEX-70: audit the BUILT platform (`pnpm platform:build` first) against a loopback fixture catalogue.
# Deterministic: no external network, bounded waits, both processes always stopped.
set -euo pipefail
cd "$(dirname "$0")/.."
FIXTURE_PORT="${SEO_FIXTURE_PORT:-3912}"
PLATFORM_PORT="${SEO_PLATFORM_PORT:-3911}"
# Must equal the build's PLATFORM_ORIGIN: "/" and "/courses" are prerendered, so their canonical is baked at build.
ORIGIN="${PLATFORM_ORIGIN:?PLATFORM_ORIGIN must equal the value used by pnpm platform:build}"
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

SEO_FIXTURE_PORT="$FIXTURE_PORT" node test/fixtures/seo-catalogue.mjs & pids+=($!)
COMMERCE_INTERNAL_ORIGIN="http://127.0.0.1:$FIXTURE_PORT" PLATFORM_ORIGIN="$ORIGIN" DEPLOY_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next start -H 127.0.0.1 -p "$PLATFORM_PORT" >/dev/null 2>&1 & pids+=($!)

for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:$PLATFORM_PORT/robots.txt').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then break; fi
  sleep 1
done

../../node_modules/.bin/tsx scripts/seo-audit.ts "http://127.0.0.1:$PLATFORM_PORT" --production --origin "$ORIGIN" \
  / /courses /courses/one /courses/two /courses/one/lessons/intro:noindex

# The WebP must appear as a visible cover, not just as an Open Graph URL.
node --input-type=module - "$PLATFORM_PORT" <<'JS'
import { strict as assert } from "node:assert";
const origin = `http://127.0.0.1:${process.argv[2]}`;
for (const [path, css] of [["/courses", "courseCardCover"], ["/courses/one", "courseHeroCover"]]) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`<img[^>]*class="${css}"[^>]*src="/course-covers/course-main-basics.webp"`));
}
const withoutCover = await fetch(origin + "/courses/two");
assert.doesNotMatch(await withoutCover.text(), /<img[^>]+courseHeroCover/);
JS
