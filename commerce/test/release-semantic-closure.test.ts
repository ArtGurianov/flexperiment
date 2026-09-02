import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseSemanticsPaths } from "../src/generic-production-deploy-boundary";

/**
 * Guards against closure drift.
 *
 * The release-semantic surface was derived from a real import closure, which
 * makes it correct today and silently wrong the moment someone adds an import.
 * If `release-control` grows an edge to a new serialization helper and nobody
 * updates the list, the generic-deploy boundary quietly reopens - the same
 * class of gap that let R7 through as an ordinary deploy.
 *
 * The assertion is containment, not equality: the protected set may reasonably
 * be wider than the static closure, because controllers and shell also couple
 * to files no TypeScript import reaches.
 */

const ROOTS = [
  "commerce/src/release-control.ts",
  "commerce/src/release-generation.ts",
  "commerce/src/sales-gate.ts",
  "commerce/src/certification-evidence.ts",
  // The release request schema, extracted out of types.ts precisely so that
  // file stops being a release-semantic root - see
  // docs/release/DEPLOYMENT_INVARIANTS.md#known-imprecision-typests.
  "commerce/src/release-control-schema.ts",
  // The deploy classifier is deliberately NOT a root: it is control plane, it
  // never runs in production, and control-plane-isolation.test.ts proves the
  // runtime cannot reach it.
];

/**
 * Type-only edges are erased before anything runs, so they cannot change how
 * release state is interpreted. `types.ts` re-exports city-catalog types this
 * way; treating that as a release-semantic dependency would drag the city list
 * into the protected set and teach everyone that the boundary is noise.
 */
const runtimeImportsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^"]+)"/g;
  for (const [, , typeKeyword, clause, specifier] of source.matchAll(pattern)) {
    if (typeKeyword) continue;                       // import type { ... } from
    if (/^\{\s*type\s/.test(clause.trim()) && !/,\s*(?!type\b)/.test(clause)) continue; // { type A, type B }
    specifiers.push(specifier);
  }
  return specifiers;
};

const resolveLocal = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalize(resolve(dirname(from), specifier));
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return relative(process.cwd(), candidate);
  }
  return undefined;
};

const closure = (): string[] => {
  const seen = new Set<string>();
  const stack = [...ROOTS];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of runtimeImportsOf(file)) {
      const resolved = resolveLocal(file, specifier);
      if (resolved) stack.push(resolved);
    }
  }
  return [...seen].sort();
};

describe("release-semantic closure", () => {
  it("resolves every root", () => {
    for (const root of ROOTS) expect(existsSync(root), `${root} is a declared root but does not exist`).toBe(true);
  });

  it("protects every runtime dependency reachable from the release-semantic roots", () => {
    const unprotected = closure().filter((file) => !releaseSemanticsPaths.includes(file));
    expect(
      unprotected,
      unprotected.length
        ? `NEW_RELEASE_SENSITIVE_DEPENDENCY\n\n`
          + unprotected.map((file) => `  ${file}`).join("\n")
          + `\n\nThese are reachable at runtime from the release-semantic roots, so a change\n`
          + `to them can alter how durable release state is interpreted - but the generic\n`
          + `deploy would still accept such a candidate as ordinary.\n\n`
          + `Either add them to releaseSemanticsPaths, or change the architecture so the\n`
          + `roots no longer depend on them. Do not delete this test.`
        : "",
    ).toEqual([]);
  });

  /**
   * The two that prove the surface is a dependency boundary and not a guess at
   * scary-looking filenames. Neither is anywhere near "migrations".
   */
  it("includes the computation the protocol trusts, not just its transitions", () => {
    const reachable = closure();
    // Every state hash, every inventory hash, every CAS comparison.
    expect(reachable).toContain("commerce/src/crypto.ts");
    // Certification evidence asserts exact 101/1/100 kopeck arithmetic, so
    // pricing maths can change what counts as a valid certification.
    expect(reachable).toContain("commerce/src/promo-pricing.ts");
  });

  it("does not drag type-only dependencies into the protected surface", () => {
    // types.ts re-exports these as `export type`, erased before runtime.
    expect(closure()).not.toContain("lib/city-catalog.ts");
    expect(releaseSemanticsPaths).not.toContain("lib/city-catalog.ts");
  });

  it("no longer reaches commerce/src/types.ts now that the request schema is extracted", () => {
    // This is the concrete regression this split exists to prevent: an
    // ordinary DTO edit in types.ts (checkout, refund, city, agent, promo,
    // settlement...) must not fall inside the release-semantic surface merely
    // because it shares a file with the release request schema anymore.
    expect(closure()).not.toContain("commerce/src/types.ts");
    expect(releaseSemanticsPaths).not.toContain("commerce/src/types.ts");
  });
});
