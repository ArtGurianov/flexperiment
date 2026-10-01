import type { LegalReleaseManifest } from "../../src/legal-control";

const document = (kind: string) => ({
  kind,
  version: `${kind}-v1`,
  sha256: "a".repeat(64),
  url: `https://flexperiment.ru/legal/${kind}`,
});

export const stageALegalManifest: LegalReleaseManifest = {
  stage: "A",
  documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map(document),
};

export const stageBLegalManifest: LegalReleaseManifest = {
  stage: "B",
  documents: [
    ...stageALegalManifest.documents,
    ...["course_offer", "receipt_contact", "fiscal_items", "refund_terms"].map(document),
  ],
};

export const stageALegalManifestJson = JSON.stringify(stageALegalManifest);
export const stageBLegalManifestJson = JSON.stringify(stageBLegalManifest);
