import { readFileSync } from "node:fs";
import { candidateRuntimeReady } from "./candidate-runtime-readiness";
import type { ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, sourceCommit, expectedMigration] = process.argv.slice(2);
if (!statusPath || !sourceCommit || !expectedMigration) throw new Error("Pass the release-control status JSON path, expected source commit, and expected migration.");
const payload = JSON.parse(readFileSync(statusPath, "utf8")) as { sales_paused?: boolean; runtime?: ReleaseRuntimeEvidence };
const ready = candidateRuntimeReady({ salesPaused: payload.sales_paused, runtime: payload.runtime, sourceCommit, expectedMigration });
if (!ready) process.exitCode = 1;
