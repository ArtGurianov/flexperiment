import { canonicalLegalManifest, type LegalManifest } from "./legal-manifest";
import type { CanonicalLegalRelease } from "./legal-release";

/**
 * Legal publication and runtime promotion are separate durable boundaries.
 *
 * The DB's active release is the legal authority; the checked-in canonical
 * manifest and current convenience copies are the runtime evidence. All of
 * them must agree before the public API may offer notification collection.
 */
export const occurrenceNotificationsCapabilityActive = (input: {
  activeVersion: string | undefined;
  activeManifest: LegalManifest | undefined;
  runtimeRelease: CanonicalLegalRelease | undefined;
  currentLegalCopiesMatch: boolean;
}): boolean => {
  const { activeVersion, activeManifest, runtimeRelease, currentLegalCopiesMatch } = input;
  if (!currentLegalCopiesMatch || !activeManifest || !runtimeRelease) return false;
  if (runtimeRelease.version !== activeVersion) return false;
  return canonicalLegalManifest(runtimeRelease.manifest) === canonicalLegalManifest(activeManifest);
};
