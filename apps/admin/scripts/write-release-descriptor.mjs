import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceCommit = process.env.SOURCE_COMMIT?.trim();
if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
  throw new Error("SOURCE_COMMIT must be the exact 40-character immutable build commit.");
}

const output = resolve(import.meta.dirname, "..", "public", "release.json");
mkdirSync(resolve(import.meta.dirname, "..", "public"), { recursive: true });
writeFileSync(output, `${JSON.stringify({ source_commit: sourceCommit, admin_contract_version: "age-band-v1" }, null, 2)}\n`);
