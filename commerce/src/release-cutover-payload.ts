import { createHash, randomUUID } from "node:crypto";
import { canonicalLegalManifest } from "./legal-manifest";
import { loadCanonicalLegalRelease } from "./legal-release";

const sourceCommit = process.argv[2];
if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Pass the exact 40-character target source commit as the first argument.");
const candidate = loadCanonicalLegalRelease(process.env.COMMERCE_RELEASE_MANIFEST_PATH ?? "commerce/legal/production-manifest.2026-08-25.1.draft.json");
const documents = candidate.manifest.documents;
console.log(JSON.stringify({
  release_id: process.env.RELEASE_ID ?? randomUUID(),
  mode: "CONTROLLED_CUTOVER",
  expected: {
    source_commit: sourceCommit,
    migration: "0033_runtime_release_evidence.sql",
    legal_version: candidate.version,
    legal_manifest_sha256: createHash("sha256").update(canonicalLegalManifest(candidate.manifest)).digest("hex"),
    legal_hashes: {
      PUBLIC_OFFER: documents.PUBLIC_OFFER.sha256,
      PRIVACY_POLICY: documents.PRIVACY_POLICY.sha256,
      PD_CONSENT: documents.PD_CONSENT.sha256,
      CHECKOUT_DISCLOSURE: documents.CHECKOUT_DISCLOSURE.sha256,
    },
  },
}));
