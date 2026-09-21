import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLegalManifest } from "../src/legal-manifest";
import { parseCanonicalLegalRelease } from "../src/legal-release";
import { occurrenceNotificationsCapabilityActive } from "../src/occurrence-notification-capability";

const activeRelease = parseCanonicalLegalRelease(JSON.parse(readFileSync("commerce/legal/production-manifest.json", "utf8")));
/**
 * The capability never reads `publish_time`, which was the only thing that
 * distinguished the promoted draft from the active release - so one fixture
 * answers for both, and the cases below vary the arguments rather than the file.
 */
const runtimeBeforePromotion = activeRelease;
const publishedNotificationRelease = activeRelease;

describe("occurrence notification legal capability", () => {
  it("recognizes the forward-ported, already-published notification release", () => {
    expect(occurrenceNotificationsCapabilityActive({
      activeVersion: runtimeBeforePromotion.version,
      activeManifest: runtimeBeforePromotion.manifest,
      runtimeRelease: runtimeBeforePromotion,
      currentLegalCopiesMatch: true,
    })).toBe(true);

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
