export type GenericProductionDeployBoundary = "SCHEMA" | "LEGAL" | "SURFACE_CONTRACT";

const isIn = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);

/**
 * Generic production deploys never carry schema, legal, or release-surface
 * contract changes. A manual controlled cutover owns every such boundary.
 */
export const genericProductionDeployBoundary = (changedPaths: readonly string[]): GenericProductionDeployBoundary | undefined => {
  if (changedPaths.some((path) => isIn(path, "commerce/migrations"))) return "SCHEMA";
  if (changedPaths.some((path) => isIn(path, "commerce/legal") || isIn(path, "public/legal"))) return "LEGAL";
  if (changedPaths.includes("release-surface-contract.json")) return "SURFACE_CONTRACT";
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
        : undefined;
};
