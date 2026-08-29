import { existsSync, readFileSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { controlPlanePaths, genericProductionDeployBoundary, releaseSemanticsPaths } from "../src/generic-production-deploy-boundary";

/**
 * Control-plane files are exempt from the generic-deploy boundary: a change to
 * the classifier takes effect when it merges to protected `main`, because
 * controllers run policy from their own checkout, and the deployed runtime
 * never observes these files at all. Requiring a production pause so
 * `production-deploy` could "catch up" was servicing an abstraction leak.
 *
 * That exemption is safe for exactly one reason, and it is a fact about the
 * import graph rather than an intention:
 *
 *   CONTROL_PLANE  intersect  runtime-import closure  =  empty
 *
 * If it ever stops holding, the exemption becomes a hole of precisely the kind
 * the boundary exists to prevent - release-semantic code shipping through the
 * generic lane - so this fails instead of letting the exemption widen.
 *
 * Direction matters and only one direction is forbidden. Control plane may
 * import runtime code freely (generic-production-deploy.ts imports
 * evaluateReopenGate, and must, to reconcile against real release state).
 * Runtime importing control plane is the violation.
 */

const RUNTIME_ENTRYPOINTS = [
  "commerce/src/server.ts",
  "commerce/src/api.ts",
  "commerce/src/domain.ts",
  "commerce/src/worker.ts",
];

/** Type-only edges are erased before anything runs; see release-semantic-closure. */
const runtimeImportsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*"([^"]+)"/g;
  for (const [, , typeKeyword, clause, specifier] of source.matchAll(pattern)) {
    if (typeKeyword) continue;
    if (/^\{\s*type\s/.test(clause.trim()) && !/,\s*(?!type\b)/.test(clause)) continue;
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

const runtimeClosure = (): string[] => {
  const seen = new Set<string>();
  const stack = [...RUNTIME_ENTRYPOINTS];
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

describe("control plane is isolated from the runtime", () => {
  it("resolves every declared control-plane file and runtime entrypoint", () => {
    for (const file of [...controlPlanePaths, ...RUNTIME_ENTRYPOINTS]) {
      expect(existsSync(file), `${file} is declared but does not exist`).toBe(true);
    }
  });

  it("reaches a real runtime closure, not an empty one", () => {
    // A typo in an entrypoint would make every assertion below vacuously true.
    const reachable = runtimeClosure();
    expect(reachable.length).toBeGreaterThan(10);
    expect(reachable).toContain("commerce/src/release-control.ts");
  });

  it("never reaches control-plane code from a runtime entrypoint", () => {
    const leaked = runtimeClosure().filter((file) => controlPlanePaths.includes(file));
    expect(
      leaked,
      leaked.length
        ? `CONTROL_PLANE_REACHABLE_FROM_RUNTIME\n\n`
          + leaked.map((file) => `  ${file}`).join("\n")
          + `\n\nThese are exempt from the generic-deploy boundary because production\n`
          + `cannot observe them. They now can. Either remove the runtime import, or\n`
          + `move the file out of controlPlanePaths and into the release-semantic\n`
          + `surface. Do not delete this test.`
        : "",
    ).toEqual([]);
  });

  it("keeps the two classifications disjoint", () => {
    const both = controlPlanePaths.filter((file) => releaseSemanticsPaths.includes(file));
    expect(both, "a path cannot be both exempt and denied").toEqual([]);
  });

  it("treats a control-plane-only change as benign for the generic lane", () => {
    expect(genericProductionDeployBoundary([...controlPlanePaths])).toBeUndefined();
  });

  it("still refuses a runtime release-control change bundled with control-plane files", () => {
    expect(genericProductionDeployBoundary([...controlPlanePaths, "commerce/src/release-control.ts"]))
      .toBe("RELEASE_SEMANTICS");
  });
});
