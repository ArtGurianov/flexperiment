import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { ORBIT_COURSE_ORDER } from "../components/home/orbit-course";

const experience = new URL("../app/(frontend)/(experience)/", import.meta.url);
it("keeps direct canonical pages separate from the dynamic home slot", () => {
  const parent = new URL("../", experience);
  const relative = "courses/[slug]/";
  for (const name of ["page.tsx", "lessons/[lessonSlug]/page.tsx"]) {
    expect(readFileSync(new URL(relative + name, parent), "utf8")).toContain("viewer");
    expect(readFileSync(new URL("@course/(.)" + relative + name, experience), "utf8")).toBeTruthy();
  }
});

it("provides both WebP layers for every configured course", () => {
  const covers = new URL("../public/course-covers/", import.meta.url);
  const expectedFiles = ORBIT_COURSE_ORDER.flatMap((artwork) => [
    `course-main-${artwork}.webp`,
    `course-shadow-${artwork}.webp`,
  ]);
  expect(readdirSync(covers).sort()).toEqual(expectedFiles.sort());
  for (const file of expectedFiles) {
    const content = readFileSync(new URL(file, covers));
    expect(content.toString("ascii", 0, 4)).toBe("RIFF");
    expect(content.toString("ascii", 8, 12)).toBe("WEBP");
  }
});
