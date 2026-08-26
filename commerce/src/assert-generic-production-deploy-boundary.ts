import { readFileSync } from "node:fs";
import { genericProductionDeployBoundaryError } from "./generic-production-deploy-boundary";

const path = process.argv[2];
if (!path) throw new Error("Pass the NUL-delimited git changed-paths file.");
const error = genericProductionDeployBoundaryError(readFileSync(path, "utf8").split("\0").filter(Boolean));
if (error) {
  console.error(error);
  process.exitCode = 1;
}
