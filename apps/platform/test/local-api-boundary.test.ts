import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(platformRoot, "../..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap((entry) => {
    if ([".next", "node_modules", "test"].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return [sourceFiles(target)];
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [Promise.resolve([target])] : [];
  }));
  return nested.flat();
}

describe("Payload-free platform source boundary", () => {
  it("has no Payload routes, config, migrations or direct source imports", async () => {
    const entries = new Set(await readdir(platformRoot));
    expect(entries.has("payload.config.ts")).toBe(false);
    expect(entries.has("migrations")).toBe(false);
    expect(entries.has("collections")).toBe(false);
    const routes = await readdir(path.join(platformRoot, "app"));
    expect(routes).not.toContain("(payload)");
    expect(routes).not.toContain("api");
    const violations: string[] = [];
    for (const file of await sourceFiles(platformRoot)) {
      const source = await readFile(file, "utf8");
      if (/(?:@payloadcms\/|from ["']payload["']|getPayload\s*\(|withPayload\s*\(|@payload-config)/.test(source)) {
        violations.push(path.relative(platformRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("builds and boots without the editorial SQLite, Payload jobs or backup runtime", async () => {
    const manifest = JSON.parse(await readFile(path.join(platformRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>; dependencies: Record<string, string>;
    };
    expect(manifest.scripts.build).toBe("next build --webpack");
    expect(Object.keys(manifest.dependencies).filter(name => name === "payload" || name.startsWith("@payloadcms/")))
      .toEqual([]);
    expect(manifest.scripts).not.toHaveProperty("migrate");
    const dockerfile = await readFile(path.join(repositoryRoot, "Dockerfile.platform"), "utf8");
    expect(dockerfile).not.toMatch(/PAYLOAD_|platform\.sqlite|platform-backup|\bmigrate\b/);
    expect(dockerfile).toContain("@flexperiment/platform start");
    const nextConfig = await readFile(path.join(platformRoot, "next.config.ts"), "utf8");
    expect(nextConfig).not.toContain("withPayload");
    const commerceServer = await readFile(path.join(repositoryRoot, "commerce-v2/src/server.ts"), "utf8");
    expect(commerceServer).not.toContain("invalidatePlatformCache:");
    expect(commerceServer).not.toContain("/internal/revalidate");
  });
});
