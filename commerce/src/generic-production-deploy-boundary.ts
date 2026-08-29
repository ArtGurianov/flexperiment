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
export const releaseSemanticsPaths: readonly string[] = [
  // The state machine, its replay, and the evidence it trusts.
  "commerce/src/release-control.ts",
  "commerce/src/release-generation.ts",
  "commerce/src/certification-evidence.ts",
  // Gate enforcement and its composition with the emergency stop.
  "commerce/src/sales-gate.ts",
  // The request schema: support the DTO rejects is not support, and widening
  // or narrowing it changes which expectations can exist at all.
  "commerce/src/types.ts",
  // Canonical serialization and hashing - state hashes, inventory hashes.
  "commerce/src/crypto.ts",
  // Timestamp parsing behind lease expiry and worker freshness.
  "commerce/src/utc-timestamp.ts",
  // Legal manifest shape behind expected legal hashes.
  "commerce/src/legal-manifest.ts",
  // Certification evidence asserts exact 101/1/100 kopeck arithmetic.
  "commerce/src/promo-pricing.ts",
  "commerce/src/basis-points.ts",
  // The boundary itself, and the deploy readiness it feeds.
  "commerce/src/generic-production-deploy-boundary.ts",
  "commerce/src/generic-production-deploy.ts",
];

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
