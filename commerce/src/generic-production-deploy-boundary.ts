export type GenericProductionDeployBoundary = "SCHEMA" | "LEGAL" | "SURFACE_CONTRACT" | "RELEASE_SEMANTICS";

const isIn = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);

/**
 * Files that can change how durable release state is interpreted or enforced,
 * even when no migration, legal document or surface descriptor moves.
 *
 * R7 is why this list exists: migrationApplied() was a defect in
 * release-control.ts, not in any migration file, and it silently changed which
 * releases could reopen. A boundary that only asks "did migrations change?"
 * would wave that through as an ordinary deploy.
 *
 * Derived from the real import closure of release-control/release-generation
 * rather than guessed by glob, and deliberately conservative: it fails toward
 * the controlled cutover, which is the safe direction.
 *
 * Enforcement lives in sales-gate.ts rather than domain.ts precisely so this
 * list can stay narrow - domain.ts changes for ordinary work, and treating it
 * as release-sensitive would make the controlled cutover the only way to ship
 * anything at all.
 */
/**
 * The release state machine, its enforcement, and the code that decides which
 * lane a change belongs in. These share one deploy protocol: pause, deploy,
 * prove convergence, reopen. Nothing here changes what a durable identity or a
 * piece of evidence *means*, so a converged runtime is sufficient proof.
 */
export const releaseControlSemanticsPaths: readonly string[] = [
  // The sole owner of expectation grammar and canonicalization.
  "commerce/src/release-expectation.ts",
  // The state machine and its replay.
  "commerce/src/release-control.ts",
  "commerce/src/release-generation.ts",
  // Gate enforcement and its composition with the emergency stop.
  "commerce/src/sales-gate.ts",
  // The request schema: support the DTO rejects is not support, and widening
  // or narrowing it changes which expectations can exist at all.
  //
  // Residual tension, deliberately accepted: this file carries every DTO, not
  // only the release request, so a checkout contract change lands here too. It
  // stays in this category because that is what makes the release expectation
  // reachable at all; if the DTOs are ever split, the non-release half should
  // leave the boundary entirely rather than move category.
  "commerce/src/types.ts",
  // The boundary itself, and the deploy readiness it feeds.
  "commerce/src/generic-production-deploy-boundary.ts",
  "commerce/src/generic-production-deploy.ts",
];

/**
 * Also too sensitive for a generic deploy, but for a different reason, and
 * therefore not deployable by the same protocol.
 *
 * Each of these changes what a durable value *means* rather than how release
 * state is driven:
 *
 *   crypto                 hash format behind state and inventory hashes, so
 *                          CAS identity itself
 *   certification-evidence what counts as certified
 *   promo-pricing          the exact 101/1/100 kopeck arithmetic that
 *   basis-points           certification evidence asserts
 *   legal-manifest         the shape behind expected legal hashes
 *   utc-timestamp          lease expiry and worker freshness
 *
 * A converged runtime does not prove any of these correct - the old and new
 * meanings can each be internally consistent and still disagree about durable
 * state written under the other. They need an evidence protocol of their own,
 * so they fail closed out of the release-control lane rather than inheriting
 * it by sharing a deny category.
 */
export const compatibilitySemanticsPaths: readonly string[] = [
  "commerce/src/crypto.ts",
  "commerce/src/certification-evidence.ts",
  "commerce/src/promo-pricing.ts",
  "commerce/src/basis-points.ts",
  "commerce/src/legal-manifest.ts",
  "commerce/src/utc-timestamp.ts",
];

/**
 * Why a generic deploy is refused. Deliberately the union: the generic lane
 * needs one answer, and the categories above exist to decide where a refused
 * change goes next, which is a different question.
 */
export const releaseSemanticsPaths: readonly string[] = [...releaseControlSemanticsPaths, ...compatibilitySemanticsPaths];

export type ReleaseSemanticsCategory = "RELEASE_CONTROL" | "COMPATIBILITY";

/** Every release-semantic category a change set touches, in refusal order. */
export const releaseSemanticsCategories = (changedPaths: readonly string[]): readonly ReleaseSemanticsCategory[] => {
  const categories: ReleaseSemanticsCategory[] = [];
  if (changedPaths.some((path) => compatibilitySemanticsPaths.includes(path))) categories.push("COMPATIBILITY");
  if (changedPaths.some((path) => releaseControlSemanticsPaths.includes(path))) categories.push("RELEASE_CONTROL");
  return categories;
};

/**
 * Generic production deploys never carry schema, legal, or release-surface
 * contract changes. A manual controlled cutover owns every such boundary.
 */
export const genericProductionDeployBoundary = (changedPaths: readonly string[]): GenericProductionDeployBoundary | undefined => {
  if (changedPaths.some((path) => isIn(path, "commerce/migrations"))) return "SCHEMA";
  if (changedPaths.some((path) => isIn(path, "commerce/legal") || isIn(path, "public/legal"))) return "LEGAL";
  if (changedPaths.includes("release-surface-contract.json")) return "SURFACE_CONTRACT";
  if (changedPaths.some((path) => releaseSemanticsPaths.includes(path))) return "RELEASE_SEMANTICS";
  return undefined;
};

export const genericProductionDeployBoundaryError = (changedPaths: readonly string[]): string | undefined => {
  const boundary = genericProductionDeployBoundary(changedPaths);
  return boundary === "SCHEMA"
    ? "GENERIC_DEPLOY_SCHEMA_PATH_BOUNDARY_CHANGED"
    : boundary === "LEGAL"
      ? "GENERIC_DEPLOY_LEGAL_PATH_BOUNDARY_CHANGED"
      : boundary === "SURFACE_CONTRACT"
        ? "GENERIC_DEPLOY_SURFACE_CONTRACT_BOUNDARY_CHANGED"
        : boundary === "RELEASE_SEMANTICS"
          ? "GENERIC_DEPLOY_RELEASE_SEMANTICS_BOUNDARY_CHANGED"
          : undefined;
};
