import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { ORBIT_COURSE_ORDER } from "../components/home/orbit-course";

const experience = new URL("../app/(frontend)/(experience)/", import.meta.url);
const directories = (path: URL) => readdirSync(path, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("keeps canonical and intercepted course paths in sync with the artwork list", () => {
  const canonical = directories(experience).filter((name) => !name.startsWith("@") && name !== "all-courses");
  const courseSlot = new URL("@course/", experience);
  const intercepted = directories(courseSlot);
  expect(canonical.sort()).toEqual([...ORBIT_COURSE_ORDER].sort());
  expect(intercepted.sort()).toEqual(ORBIT_COURSE_ORDER.map((name) => `(.)${name}`).sort());
  for (const artwork of ORBIT_COURSE_ORDER) {
    expect(readFileSync(new URL(`${artwork}/page.tsx`, experience), "utf8")).toContain(`artwork="${artwork}"`);
    expect(readFileSync(new URL(`(.)${artwork}/page.tsx`, courseSlot), "utf8")).toContain(`artwork="${artwork}"`);
  }
});
