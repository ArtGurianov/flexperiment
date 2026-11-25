import { cacheLife } from "next/cache";
import { allowsCanaryCommerceRequest, validatePlatformCanary } from "./canary-config";
import { currentCoursesLegalRelease } from "./legal-release-server";
import { platformOrigin } from "./origins";

async function cachedPrivacyLinkDate() {
  "use cache";
  cacheLife({ stale: 0, revalidate: 5, expire: 15 });

  // This cache only supplies a display date for links to the current policy.
  // Document pages and consent forms read the active edition independently.
  const origin = new URL(platformOrigin());
  try {
    const release = await currentCoursesLegalRelease(origin.host, null);
    return release?.manifest.documents.some(document => document.kind === "privacy") ? release.effectiveAt : null;
  } catch {
    return null;
  }
}

export async function privacyLinkEffectiveAt(headers: Pick<Headers, "get">) {
  try {
    if (validatePlatformCanary() && !allowsCanaryCommerceRequest(headers.get("host"), headers.get("origin"))) return null;
  } catch {
    return null;
  }
  return cachedPrivacyLinkDate();
}
