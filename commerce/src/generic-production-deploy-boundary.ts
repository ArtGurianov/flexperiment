export type GenericProductionDeployBoundary = "SCHEMA" | "LEGAL";

const isIn = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);

/**
 * Generic production deploys never carry schema or legal source changes.
 * A manual controlled cutover owns either boundary.
 */
export const genericProductionDeployBoundary = (changedPaths: readonly string[]): GenericProductionDeployBoundary | undefined => {
  if (changedPaths.some((path) => isIn(path, "commerce/migrations"))) return "SCHEMA";
  if (changedPaths.some((path) => isIn(path, "commerce/legal") || isIn(path, "public/legal"))) return "LEGAL";
  return undefined;
};

export const genericProductionDeployBoundaryError = (changedPaths: readonly string[]): string | undefined => {
  const boundary = genericProductionDeployBoundary(changedPaths);
  return boundary === "SCHEMA"
    ? "GENERIC_DEPLOY_REQUIRES_CONTROLLED_SCHEMA_CUTOVER"
    : boundary === "LEGAL"
      ? "GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER"
      : undefined;
};
