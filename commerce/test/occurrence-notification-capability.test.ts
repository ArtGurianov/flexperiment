import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegalManifest } from "../src/legal-manifest";
import { parseCanonicalLegalRelease } from "../src/legal-release";
import { occurrenceNotificationsCapabilityActive } from "../src/occurrence-notification-capability";

const runtimeBeforePromotion = parseCanonicalLegalRelease(JSON.parse(readFileSync("commerce/legal/production-manifest.json", "utf8")));
const publishedNotificationRelease = parseCanonicalLegalRelease(JSON.parse(readFileSync("commerce/legal/production-manifest.2026-08-28.1.draft.json", "utf8")));

describe("occurrence notification legal capability", () => {
  it("stays dormant before publication and after publication until runtime promotion", () => {
    expect(occurrenceNotificationsCapabilityActive({
      activeVersion: runtimeBeforePromotion.version,
      activeManifest: runtimeBeforePromotion.manifest,
      runtimeRelease: runtimeBeforePromotion,
      currentLegalCopiesMatch: true,
    })).toBe(false);

    expect(occurrenceNotificationsCapabilityActive({
      activeVersion: publishedNotificationRelease.version,
      activeManifest: publishedNotificationRelease.manifest,
      runtimeRelease: runtimeBeforePromotion,
      currentLegalCopiesMatch: false,
    })).toBe(false);
  });

  it("activates only when the promoted runtime manifest and current legal copies exactly match the active release", () => {
    expect(occurrenceNotificationsCapabilityActive({
      activeVersion: publishedNotificationRelease.version,
      activeManifest: publishedNotificationRelease.manifest,
      runtimeRelease: publishedNotificationRelease,
      currentLegalCopiesMatch: true,
    })).toBe(true);

    const altered = parseLegalManifest({
      documents: {
        ...publishedNotificationRelease.manifest.documents,
        PD_CONSENT: { ...publishedNotificationRelease.manifest.documents.PD_CONSENT, sha256: "0".repeat(64) },
      },
    });
    expect(occurrenceNotificationsCapabilityActive({
      activeVersion: publishedNotificationRelease.version,
      activeManifest: publishedNotificationRelease.manifest,
      runtimeRelease: { ...publishedNotificationRelease, manifest: altered },
      currentLegalCopiesMatch: true,
    })).toBe(false);
  });
});
