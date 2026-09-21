import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const filesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return filesUnder(path);
  return entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx")) ? [path] : [];
});
const sourceFiles = filesUnder(join(root, "commerce/src"));
const releaseTests = filesUnder(join(root, "commerce/test/release"));
const source = sourceFiles.map((path) => [relative(root, path), readFileSync(path, "utf8")] as const);
const all = [...source, ...releaseTests.map((path) => [relative(root, path), readFileSync(path, "utf8")] as const)];

describe("runtime quiescence source boundary", () => {
  it("has no legacy evidence/registry API, lease casts/literals, or optional authority", () => {
    const banned = [
      ["Runtime", "Quiescence", "Evidence"].join(""),
      ["Runtime", "Quiescence", "Registry"].join(""),
    ];
    for (const identifier of banned) {
      expect(all.filter(([, text]) => text.includes(identifier)).map(([path]) => path)).toEqual([]);
    }
    const prohibitedPatterns = [
      /as\s+RuntimeQuiescenceLease/,
      /RuntimeQuiescenceLease\s*=\s*\{/,
      /authority\s*\?:/,
      /ensureStopped\s*\(/,
    ];
    for (const pattern of prohibitedPatterns) {
      expect(all.filter(([, text]) => pattern.test(text)).map(([path]) => path)).toEqual([]);
    }
  });

  it("constructs one production authority and passes that identity to issuer and consumer", () => {
    const constructions = source.flatMap(([path, text]) => [...text.matchAll(/new RuntimeQuiescenceAuthority\s*\(/g)].map(() => path));
    expect(constructions).toEqual(["commerce/src/release/production-runner.ts"]);
    const productionRoot = readFileSync(join(root, "commerce/src/release/production-runner.ts"), "utf8");
    expect(productionRoot).toContain("authority: runtimeQuiescenceAuthority");
    expect(productionRoot).toContain("authority: runtimeQuiescenceAuthority, revalidation: runtimeQuiescer");
  });
});
