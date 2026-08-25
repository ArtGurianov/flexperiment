import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceCommit = process.env.SOURCE_COMMIT?.trim();
if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("SOURCE_COMMIT must be the exact 40-character immutable build commit.");
writeFileSync(resolve(process.cwd(), "public/release.json"), `${JSON.stringify({ source_commit: sourceCommit, checkout_contract_version: "age-band-v1" }, null, 2)}\n`);
