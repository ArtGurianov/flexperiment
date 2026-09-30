import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Courses } from "../collections/Courses";
import { Sections } from "../collections/Sections";
import { authorOrStorefront, publicPublishedAndListed } from "../lib/access";
import { immutableRelationAfterPublish } from "../lib/content-lifecycle";
import { orderCourseTree } from "../lib/content/editorial";

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

  it("exposes the orderable course tree through Payload joins", () => {
    expect(Courses.fields).toContainEqual(expect.objectContaining({
      name: "sections",
      type: "join",
      collection: "sections",
      on: "course",
      orderable: true,
      defaultSort: "_sections_sections_order",
    }));
    expect(Sections.fields).toContainEqual(expect.objectContaining({
      name: "lessons",
      type: "join",
      collection: "lessons",
      on: "section",
      orderable: true,
      defaultSort: "_lessons_lessons_order",
    }));
  });

  it("derives public positions from each join's persisted order", () => {
    const tree = orderCourseTree(
      [
        { id: 2, title: "Second", position: 0, _sections_sections_order: "b" },
        { id: 1, title: "First", position: 9, _sections_sections_order: "a" },
      ],
      [
        { id: 3, section: 1, title: "First / second", position: 0, _lessons_lessons_order: "b" },
        { id: 2, section: 2, title: "Second / first", position: 0, _lessons_lessons_order: "a" },
        { id: 1, section: 1, title: "First / first", position: 7, _lessons_lessons_order: "a" },
      ],
    );

    expect(tree.sections.map(({ id, position }) => [id, position])).toEqual([[1, 0], [2, 1]]);
    expect(tree.lessons.map(({ id, position }) => [id, position])).toEqual([[1, 0], [3, 1], [2, 0]]);
    expect(JSON.stringify(tree)).not.toContain("_order");
  });
});
