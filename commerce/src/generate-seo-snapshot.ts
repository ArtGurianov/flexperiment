import { resolve } from "node:path";

import {
  findSnapshotDefects,
  findTransitionDefects,
  judgeOccurrence,
} from "../../lib/seo/occurrence-publication";
import { buildSnapshot } from "../../lib/seo/public-occurrence";
import {
  fetchSource,
  readRecordedSource,
  readSnapshotOrEmpty,
  serializeSnapshot,
  SNAPSHOT_PATH,
  writeSnapshotFile,
} from "./seo-snapshot-io";

/**
 * Regenerates data/seo/occurrences.v1.json from Commerce's public tour.
 *
 *   --source <origin>  the production path, e.g. https://api.flexperiment.ru
 *   --input <file>     a recorded source reading, for fixtures and CI
 *   --out <file>       where to write (default: data/seo/occurrences.v1.json)
 *   --previous <file>  the snapshot to preserve frozen slugs from (default: --out)
 *   --check            do not write; exit 1 if the output would differ
 *
 * Exactly one of --source and --input is required. The stages stay separate and
 * ordered — fetch, parse against the expected API contract, canonicalize,
 * validate, write — and each one fails outright rather than proceeding on
 * partial data. There is no best-effort mode: a snapshot generated from a
 * response this code did not fully understand is worse than no snapshot, since
 * everything downstream treats it as a commercial fact.
 *
 * Argument parsing follows the house template
 * (commerce/src/materialize-release-control-v2-candidate.ts): hand-rolled,
 * rejecting duplicates and unknown flags, one SCREAMING_SNAKE code to stderr,
 * exit status as the output.
 */

const FLAGS = ["--source", "--input", "--out", "--previous"] as const;
const BOOLEAN_FLAGS = ["--check"] as const;

type Arguments = {
  readonly source?: string;
  readonly input?: string;
  readonly out: string;
  readonly previous: string;
  readonly check: boolean;
};

const parseArguments = (argv: readonly string[]): Arguments => {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const name = argv[index];
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (booleans.has(name)) throw new Error("SEO_SNAPSHOT_GENERATE_ARGUMENTS_INVALID");
      booleans.add(name);
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!name || !value || !(FLAGS as readonly string[]).includes(name) || values.has(name)) {
      throw new Error("SEO_SNAPSHOT_GENERATE_ARGUMENTS_INVALID");
    }
    values.set(name, value);
    index += 2;
  }

  const source = values.get("--source");
  const input = values.get("--input");
  // Exactly one source. Accepting both would leave it ambiguous which one the
  // committed artifact actually came from, which is the whole question the
  // refresh obligation turns on.
  if ((source ? 1 : 0) + (input ? 1 : 0) !== 1) {
    throw new Error("SEO_SNAPSHOT_GENERATE_ARGUMENTS_INVALID");
  }
  const out = values.get("--out") ?? SNAPSHOT_PATH;
  return { source, input, out, previous: values.get("--previous") ?? out, check: booleans.has("--check") };
};

const main = async () => {
  const args = parseArguments(process.argv.slice(2));
  const previous = readSnapshotOrEmpty(args.previous);
  const previouslyPublishedIds = [...previous.occurrences, ...previous.tombstones].map((entry) => entry.id);

  const source = args.input
    ? readRecordedSource(args.input)
    : await fetchSource(args.source!, previouslyPublishedIds);

  const next = buildSnapshot({ source, previous, nowMs: Date.now() });

  // An INVALID record in live inventory is an operator problem, not a record to
  // quietly drop: a contradiction like a Saint Petersburg occurrence carrying
  // Asia/Novosibirsk means something is wrong in Commerce, and a generator that
  // silently omitted it would hide that indefinitely.
  const invalid = next.occurrences
    .map((entry) => ({ entry, verdict: judgeOccurrence(entry) }))
    .filter(({ verdict }) => verdict.outcome === "INVALID");
  if (invalid.length > 0) {
    for (const { entry, verdict } of invalid) {
      process.stderr.write(`SEO_SNAPSHOT_OCCURRENCE_INVALID ${entry.id} ${verdict.reasons.join(",")}\n`);
    }
    throw new Error("SEO_SNAPSHOT_OCCURRENCE_INVALID");
  }

  for (const defect of findSnapshotDefects(next)) {
    process.stderr.write(`SEO_SNAPSHOT_DEFECT ${defect.code} ${defect.detail}\n`);
  }
  if (findSnapshotDefects(next).length > 0) throw new Error("SEO_SNAPSHOT_DEFECTIVE");

  const transitions = findTransitionDefects(previous, next);
  for (const defect of transitions) {
    process.stderr.write(`SEO_SNAPSHOT_TRANSITION_DEFECT ${defect.code} ${defect.detail}\n`);
  }
  if (transitions.length > 0) throw new Error("SEO_SNAPSHOT_TRANSITION_REFUSED");

  const serialized = serializeSnapshot(next);
  if (args.check) {
    const current = serializeSnapshot(readSnapshotOrEmpty(args.out));
    if (current !== serialized) throw new Error("SEO_SNAPSHOT_STALE");
    process.stdout.write(`${resolve(args.out)} up to date\n`);
    return;
  }

  writeSnapshotFile(args.out, next);
  process.stdout.write(
    `${resolve(args.out)} ${next.occurrences.length} occurrence(s), ${next.tombstones.length} tombstone(s)\n`,
  );
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
