import { createHash } from "node:crypto";
import type { CourseManifest } from "./contracts";

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
};

export function withManifestHash(manifest: Omit<CourseManifest, "contentHash">): CourseManifest {
  const contentHash = createHash("sha256").update(JSON.stringify(stable(manifest))).digest("hex");
  return { ...manifest, contentHash };
}
