import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Direct failure-behavior coverage for the checked-in legal-manifest hash
 * calculator (commerce/src/calculate-legal-manifest-hashes.ts) - the same
 * executable the Epoch A prepare preflight workflow and
 * verify-epoch-a-prepare-preflight-workflow.test.ts both run. Every case
 * here must exit nonzero and print nothing to stdout; the workflow's own
 * `|| blocked LEGAL_MANIFEST_HASH_CALCULATION_FAILED` depends on exactly
 * that fail-closed contract.
 */

const CALCULATOR_PATH = "commerce/src/calculate-legal-manifest-hashes.ts";

const runCalculator = (manifestPath: string) =>
  execFileSync(process.execPath, ["--import", "tsx", CALCULATOR_PATH, manifestPath], { encoding: "utf8" });

const scratchFile = (name: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "legal-manifest-hash-calculator-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("calculate-legal-manifest-hashes.ts: fail-closed on every invalid input", () => {
  it("a missing file exits nonzero with no stdout", () => {
    const missingPath = join(mkdtempSync(join(tmpdir(), "legal-manifest-hash-calculator-")), "does-not-exist.json");
    expect(() => runCalculator(missingPath)).toThrow();
    try {
      runCalculator(missingPath);
      throw new Error("expected the calculator to exit nonzero");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      expect(stdout).toBe("");
    }
  });

  it("invalid JSON exits nonzero with no stdout", () => {
    const path = scratchFile("invalid.json", "{ not valid json");
    expect(() => runCalculator(path)).toThrow();
    try {
      runCalculator(path);
      throw new Error("expected the calculator to exit nonzero");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      expect(stdout).toBe("");
    }
  });

  it("valid JSON that is not a valid legal manifest exits nonzero with no stdout", () => {
    const path = scratchFile("not-a-manifest.json", JSON.stringify({ documents: {} }));
    expect(() => runCalculator(path)).toThrow();
    try {
      runCalculator(path);
      throw new Error("expected the calculator to exit nonzero");
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      expect(stdout).toBe("");
    }
  });

  it("no manifest-path argument at all exits nonzero with no stdout", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", CALCULATOR_PATH], { encoding: "utf8" })).toThrow();
  });
});
