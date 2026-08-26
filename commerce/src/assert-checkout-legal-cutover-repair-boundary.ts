import { readFileSync } from "node:fs";
import { checkoutLegalCutoverRepairBoundaryError } from "./checkout-legal-cutover-repair-boundary";

const path = process.argv[2];
if (!path) throw new Error("Pass the NUL-delimited git changed-paths file.");
const error = checkoutLegalCutoverRepairBoundaryError(readFileSync(path, "utf8").split("\0").filter(Boolean));
if (error) {
  console.error(error);
  process.exitCode = 1;
}
