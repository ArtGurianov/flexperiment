import { readFileSync } from "node:fs";
import { genericProductionDeployBoundary, releaseSemanticsCategories } from "./generic-production-deploy-boundary";

/**
 * The admission test for the release-semantics cutover lane.
 *
 * This lane exists because release-semantic changes cannot ship through the
 * generic controller - it refuses them by design - and cannot reasonably
 * demand the full candidate protocol either, since they carry no migration and
 * no legal document.
 *
 * It is deliberately NOT "the generic deploy without the boundary check". A
 * lane that merely skipped the assertion would be a general-purpose bypass, and
 * the boundary would be worth nothing the moment anyone reached for it. So the
 * verdict must be exactly RELEASE_SEMANTICS:
 *
 *   undefined  the change is benign and belongs in the generic lane, which
 *              proves more about it than this one does
 *   SCHEMA     a migration needs the candidate protocol and its certification
 *   LEGAL      a legal document needs publication and promotion
 *   SURFACE_   a surface contract change needs its own controller
 *
 * Every one of those is a refusal. This lane can only ever widen to the exact
 * category it was opened for.
 */

const path = process.argv[2];
if (!path) throw new Error("Pass the NUL-delimited git changed-paths file.");

const changedPaths = readFileSync(path, "utf8").split("\0").filter(Boolean);
const boundary = genericProductionDeployBoundary(changedPaths);

if (boundary === undefined) {
  console.error("RELEASE_SEMANTICS_CUTOVER_CHANGE_IS_BENIGN_USE_GENERIC_DEPLOY");
  process.exitCode = 1;
} else if (boundary !== "RELEASE_SEMANTICS") {
  console.error(`RELEASE_SEMANTICS_CUTOVER_BOUNDARY_TOO_WIDE=${boundary}`);
  process.exitCode = 1;
} else {
  /**
   * RELEASE_SEMANTICS says why the generic lane refused the change. It does not
   * say that everything it refuses should ship the same way, and the two are
   * easy to conflate because they share a name.
   *
   * A compatibility change - hash format, certification arithmetic, timestamp
   * semantics - is not proven by a converged runtime, so it must not inherit
   * this lane merely by falling into the same deny category.
   */
  const categories = releaseSemanticsCategories(changedPaths);
  const disallowed = categories.filter((category) => category !== "RELEASE_CONTROL");
  if (disallowed.length > 0) {
    console.error(`RELEASE_SEMANTICS_CUTOVER_CATEGORY_NOT_ADMITTED=${disallowed.join(",")}`);
    process.exitCode = 1;
  } else {
    console.log("RELEASE_SEMANTICS_CUTOVER_BOUNDARY_EXACT");
  }
}
