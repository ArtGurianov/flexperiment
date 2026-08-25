import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function writeAdminReleaseDescriptor({
  sourceCommit = process.env.SOURCE_COMMIT?.trim(),
  output = resolve(import.meta.dirname, "..", "public", "release.json"),
} = {}) {
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("SOURCE_COMMIT must be the exact 40-character immutable build commit.");
  }

  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ source_commit: sourceCommit, admin_contract_version: "age-band-v1" }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeAdminReleaseDescriptor();
}
