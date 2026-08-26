import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function writeStaticReleaseDescriptor({
  sourceCommit = process.env.SOURCE_COMMIT?.trim(),
  output = resolve(process.cwd(), "public/release.json"),
}: {
  sourceCommit?: string;
  output?: string;
} = {}) {
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("SOURCE_COMMIT must be the exact 40-character immutable build commit.");
  }

  const contracts = JSON.parse(readFileSync(resolve(process.cwd(), "release-surface-contract.json"), "utf8")) as { checkout_contract_version?: unknown };
  if (typeof contracts.checkout_contract_version !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(contracts.checkout_contract_version)) {
    throw new Error("checkout_contract_version must be a safe immutable release identifier.");
  }
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ source_commit: sourceCommit, checkout_contract_version: contracts.checkout_contract_version }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeStaticReleaseDescriptor();
}
