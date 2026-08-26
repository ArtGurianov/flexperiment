import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function writeAdminReleaseDescriptor({
  sourceCommit = process.env.SOURCE_COMMIT?.trim(),
  output = resolve(import.meta.dirname, "..", "public", "release.json"),
} = {}) {
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("SOURCE_COMMIT must be the exact 40-character immutable build commit.");
  }

  const contracts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../release-surface-contract.json"), "utf8"));
  if (typeof contracts.admin_contract_version !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(contracts.admin_contract_version)) {
    throw new Error("admin_contract_version must be a safe immutable release identifier.");
  }
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ source_commit: sourceCommit, admin_contract_version: contracts.admin_contract_version }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeAdminReleaseDescriptor();
}
