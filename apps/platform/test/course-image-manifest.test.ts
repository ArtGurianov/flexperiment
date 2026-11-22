import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COURSE_IMAGE_MANIFEST } from "../lib/public-media";

// FLEX-63 Stage A: the manifest must describe the shipped bytes exactly, or a page would publish a
// dishonest og:image size. This reads each file's WebP container header (VP8X/VP8/VP8L) directly.
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");

function webpSize(bytes: Buffer) {
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

describe("course image manifest", () => {
  it.each(COURSE_IMAGE_MANIFEST.map((entry) => [entry.courseRef, entry] as const))("%s matches its shipped WebP", async (_ref, entry) => {
    expect(entry.courseRef).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,119}$/);
    expect(entry.path).toMatch(/^\/course-covers\/[a-z0-9-]+\.webp$/);
    const bytes = await readFile(path.join(publicRoot, entry.path));
    expect(bytes.length).toBe(entry.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    expect(webpSize(bytes)).toEqual({ width: entry.width, height: entry.height });
  });

  // Course-main covers only: the carousel's silhouette layer (#284, course-shadow-*) is decorative, not a course image.
  it("maps every shipped course cover, so no unreviewed course image is served", async () => {
    const shipped = (await readdir(path.join(publicRoot, "course-covers")))
      .filter((name) => name.startsWith("course-main-")).map((name) => `/course-covers/${name}`).sort();
    expect(shipped).toEqual(COURSE_IMAGE_MANIFEST.map((entry) => entry.path).sort());
  });
});
