import { canonicalLegalManifest, type LegalManifest } from "./legal-manifest";
import type { CanonicalLegalRelease } from "./legal-release";

/**
 * The release approved for the occurrence-availability service purpose. The
 * runtime may carry this code before publication, but must not expose the
 * capability until its own canonical legal artifact has caught up with the
 * active durable release.
 */
export const OCCURRENCE_NOTIFICATION_LEGAL_VERSION = "2026-08-28.1";

const requiredConsentHashes = {
  PRIVACY_POLICY: "642d11458733e8c1e5bfb28d0cde7f917a276dfcb3e32dc52adc34fac6326339",
  PD_CONSENT: "acdb8a31a846c1c697cfd977fb67f24e75d280ab72cb6fbce5bbf0146d4ba5b6",
} as const;

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
  if (activeVersion !== OCCURRENCE_NOTIFICATION_LEGAL_VERSION) return false;
  if (runtimeRelease.version !== activeVersion) return false;
  if (canonicalLegalManifest(runtimeRelease.manifest) !== canonicalLegalManifest(activeManifest)) return false;
  return activeManifest.documents.PRIVACY_POLICY.sha256 === requiredConsentHashes.PRIVACY_POLICY
    && activeManifest.documents.PD_CONSENT.sha256 === requiredConsentHashes.PD_CONSENT;
};
