import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The manifest classification for BASE d6ca9dc, held to the real endpoint
 * diff rather than to prose.
 *
 * Two categories - 152 tests and 174 control-plane paths - are far too large
 * to review by reading, and the review that found this necessary had already
 * caught six control-plane files leaking into the certified set on nothing
 * but an `agent-referrals-*` filename. So the classification is a committed
 * artifact and this proves it is a genuine PARTITION of
 *
 *   git diff --name-status <base_sha> <source_main_sha>
 *
 * with exact membership, exact A/M/D status, one category per path, and
 * counts derived rather than asserted.
 *
 * The comparison is between two exact trees, deliberately. GitHub's compare
 * view applies merge-base semantics, which for these diverged histories
 * reports a different and misleading set - it is not an authority here.
 */

const CLASSIFICATION = ".release/controlled-candidates/agent-referrals-d6ca9dc5f25e4df49ef15a72fae75ef69ee42172/classification.tsv";

type Row = { status: string; disposition: string; category: string; path: string; reconciliation?: string };

const text = readFileSync(join(process.cwd(), CLASSIFICATION), "utf8");
const header = Object.fromEntries(
  text.split("\n").filter((line) => line.startsWith("# ") && line.includes("\t"))
    .map((line) => line.replace(/^# /, "").split("\t") as [string, string]),
);
const rows: Row[] = text.split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
  const [status, disposition, category, path, reconciliation] = line.split("\t");
  return { status, disposition, category, path, reconciliation };
});

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }).trimEnd();
const objectPresent = (sha: string) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]).status === 0;

describe("candidate classification is a partition of the exact endpoint diff", () => {
  const baseSha = header.base_sha;
  const sourceMainSha = header.source_main_sha;

  it("names its two endpoints, and both are present as objects", () => {
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceMainSha).toMatch(/^[0-9a-f]{40}$/);
    // CI fetches production-deploy (see .github/workflows/test.yml). If this
    // fails the classification cannot be checked at all, which must be loud
    // rather than skipped.
    expect(objectPresent(baseSha), `BASE ${baseSha} is not in this clone - fetch production-deploy`).toBe(true);
    expect(objectPresent(sourceMainSha), `source main ${sourceMainSha} is not in this clone`).toBe(true);
  });

  it("covers exactly the diffed paths, with exactly their statuses", () => {
    const actual = git(["diff", "--name-status", baseSha, sourceMainSha])
      .split("\n").filter(Boolean)
      .map((line) => { const [status, path] = line.split("\t"); return `${status}\t${path}`; })
      .sort();
    const classified = rows.map((row) => `${row.status}\t${row.path}`).sort();

    expect(classified).toEqual(actual);
  });

  it("assigns exactly one category per path", () => {
    const seen = new Set<string>();
    for (const row of rows) {
      expect(seen.has(row.path), `duplicate classification for ${row.path}`).toBe(false);
      seen.add(row.path);
    }
    expect(seen.size).toBe(rows.length);
  });

  it("uses only the agreed dispositions and categories", () => {
    const categories = new Set(["WHOLE_FILE", "SHARED", "TEST", "CONTROL_PLANE", "UNRELATED_RUNTIME", "ROOT", "FORBIDDEN_LEGAL"]);
    for (const row of rows) {
      expect(["CERTIFIED", "EXCLUDED"]).toContain(row.disposition);
      expect(categories, `unknown category for ${row.path}`).toContain(row.category);
      expect(row.disposition === "CERTIFIED").toBe(row.category === "WHOLE_FILE" || row.category === "SHARED");
    }
  });

  it("certifies nothing the certificate itself forbids, and no control plane", () => {
    const certified = rows.filter((row) => row.disposition === "CERTIFIED").map((row) => row.path);
    for (const path of certified) {
      expect(path.startsWith("public/legal/") || path.startsWith("commerce/legal/"), `legal path certified: ${path}`).toBe(false);
      expect(path.startsWith(".github/") || path.startsWith("docs/") || path.startsWith("scripts/") || path.startsWith(".release/"),
        `control-plane path certified: ${path}`).toBe(false);
      expect(/\/test\/|\.test\.tsx?$/.test(path), `test path certified: ${path}`).toBe(false);
    }
  });

  /**
   * The check that makes the OTP class of defect unrepeatable - by
   * construction rather than by proxy.
   *
   * The first version of this guard compared exported NAMES, and it was not
   * enough: commerce/src/server.ts exports nothing at all, so re-certifying
   * it would have stayed green while the source version stopped passing an
   * OTP sender to createApp and silently returned production to
   * UnconfiguredOtpSender. Comparing export bodies would have been a
   * proxy too - a private helper, an import, a constant or one line of
   * top-level wiring all slip past it.
   *
   * BASE pins its own provenance, which gives an exact oracle instead:
   *
   *   O = the source commit BASE was materialized from (6ab81df)
   *   B = production BASE          - O plus production-only changes
   *   S = the frozen source main   - O plus ordinary main history
   *
   * Three-way merging S's changes onto B, with O as the base, answers the
   * only question that matters: does taking S's blob whole DESTROY anything
   * B carries? If the merge result is byte-identical to S, B held nothing
   * extra and WHOLE_FILE is safe. Anything else - a difference or a
   * conflict - means B has production-only content, whatever kind it is.
   */
  it("every certified WHOLE_FILE modification survives a three-way merge onto BASE unchanged", () => {
    const sourceOfBase = git(["log", "-1", "--format=%b", baseSha])
      .split("\n").map((line) => line.trim())
      .find((line) => line.startsWith("source:"))?.replace("source:", "").trim() ?? "";
    expect(sourceOfBase, "BASE must pin the source commit it was materialized from").toMatch(/^[0-9a-f]{40}$/);
    expect(objectPresent(sourceOfBase)).toBe(true);

    const blobTo = (ref: string, path: string, file: string): boolean => {
      const shown = spawnSync("git", ["show", `${ref}:${path}`], { maxBuffer: 1024 * 1024 * 64 });
      writeFileSync(file, shown.status === 0 ? (shown.stdout ?? Buffer.alloc(0)) : Buffer.alloc(0));
      return shown.status === 0;
    };

    const unsafe: string[] = [];
    const scratch = mkdtempSync(join(tmpdir(), "candidate-threeway-"));
    try {
      for (const row of rows) {
        if (row.disposition !== "CERTIFIED" || row.category !== "WHOLE_FILE" || row.status !== "M") continue;

        const current = join(scratch, "current");
        const base = join(scratch, "base");
        const other = join(scratch, "other");
        blobTo(baseSha, row.path, current);
        const hadBase = blobTo(sourceOfBase, row.path, base);
        blobTo(sourceMainSha, row.path, other);

        // A path BASE's own source never had cannot be reconciled this way,
        // so it is refused rather than guessed at.
        if (!hadBase) { unsafe.push(`${row.path} (absent from BASE's source commit)`); continue; }

        const merged = spawnSync("git", ["merge-file", "-p", "--quiet", current, base, other], { maxBuffer: 1024 * 1024 * 64 });
        if ((merged.status ?? 1) !== 0) { unsafe.push(`${row.path} (three-way conflict)`); continue; }
        if (!Buffer.from(merged.stdout ?? []).equals(readFileSync(other))) {
          unsafe.push(`${row.path} (BASE carries content the source blob would destroy)`);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    expect(unsafe, "these paths must be SHARED, not WHOLE_FILE").toEqual([]);
  });

  /**
   * Paths already proven to belong outside the candidate. The generic
   * control-plane predicate above is prefix-based and would not catch
   * commerce/src/agent-referrals-candidate.ts - release machinery that lives
   * under a runtime root and is named like the feature.
   */
  it("keeps the paths already ruled out of the candidate excluded", () => {
    const mustRemainExcluded = [
      "commerce/src/agent-referrals-candidate.ts",
      "commerce/src/agent-referrals-candidate-author.ts",
      "commerce/src/agent-referrals-activation.ts",
      "commerce/src/agent-referrals-activation-readiness.ts",
      "commerce/src/agent-referrals-activation-reconciliation.ts",
      "commerce/src/agent-referrals-business-facts.ts",
      "commerce/src/agent-referrals-dormant-readiness.ts",
      "commerce/src/agent-referrals-otp.ts",
      "commerce/src/server.ts",
    ];
    for (const path of mustRemainExcluded) {
      const row = rows.find((candidate) => candidate.path === path);
      expect(row, `${path} is expected in the classification`).toBeDefined();
      expect(row!.disposition, `${path} must stay excluded`).toBe("EXCLUDED");
    }
  });

  it("counts are derived from the artifact, not asserted beside it", () => {
    const byCategory = rows.reduce<Record<string, number>>((totals, row) => {
      totals[row.category] = (totals[row.category] ?? 0) + 1;
      return totals;
    }, {});
    const certified = rows.filter((row) => row.disposition === "CERTIFIED").length;

    expect(rows.length).toBe(Object.values(byCategory).reduce((sum, count) => sum + count, 0));
    expect(certified).toBe((byCategory.WHOLE_FILE ?? 0) + (byCategory.SHARED ?? 0));
    // The one number worth pinning: certified paths are what a reviewer reads
    // line by line, so a change to that set must be deliberate.
    expect(certified).toBe(61);
  });
});
