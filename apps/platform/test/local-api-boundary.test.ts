import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authorOrStorefront, publicPublishedAndListed } from "../lib/access";
import { immutableRelationAfterPublish } from "../lib/content-lifecycle";

const platformRoot = path.resolve(import.meta.dirname, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.flatMap((entry) => {
    if ([".next", "node_modules", "migrations", "test"].includes(entry.name)) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return [sourceFiles(target)];
    return /\.(ts|tsx)$/.test(entry.name) ? [Promise.resolve([target])] : [];
  }));
  return nested.flat();
}

describe("Payload public-data boundary", () => {
  it("keeps Local API reads inside lib/content", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(platformRoot)) {
      if (file.includes(`${path.sep}lib${path.sep}content${path.sep}`)) continue;
      const source = await readFile(file, "utf8");
      if (/\.find(?:ByID)?\s*\(/.test(source)) violations.push(path.relative(platformRoot, file));
    }
    expect(violations).toEqual([]);
  });

  it("denies anonymous REST-style reads and allows only explicit storefront context", () => {
    const base = { req: { user: null, context: {} } } as never;
    expect(publicPublishedAndListed(base)).toBe(false);
    const storefront = { req: { user: null, context: { storefront: true } } } as never;
    expect(publicPublishedAndListed(storefront)).toEqual({ and: [
      { _status: { equals: "published" } },
      { visibility: { equals: "listed" } },
    ] });
    expect(authorOrStorefront(base)).toBe(false);
    expect(authorOrStorefront(storefront)).toBe(true);
  });

  it("keeps an ever-published lesson attached to its original course", () => {
    const hook = immutableRelationAfterPublish("course");
    expect(() => hook({ originalDoc: { everPublished: true, course: 1 }, value: 2 } as never)).toThrow("COURSE_IMMUTABLE_AFTER_PUBLISH");
    expect(hook({ originalDoc: { everPublished: true, course: 1 }, value: { id: 1 } } as never)).toEqual({ id: 1 });
  });
});
