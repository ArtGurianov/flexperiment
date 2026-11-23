import { createHash } from "node:crypto";
import { parseLabInterestManifest } from "../../src/lab-interest-legal";

export const labInterestManifestBytes = Buffer.from(JSON.stringify({
  type: "LAB_INTEREST", version: "fixture-lab-interest",
  documents: { lab_interest_consent: "Synthetic consent for the selected city.", privacy: "Synthetic LAB interest privacy policy." },
}));
export const labInterestManifestSha256 = createHash("sha256").update(labInterestManifestBytes).digest("hex");
export const labInterestManifest = parseLabInterestManifest(labInterestManifestBytes, labInterestManifestSha256)!;
