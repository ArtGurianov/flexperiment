import { openReadOnlyDatabase } from "./db";
import { LegalReleasePublishError, verifyLegalArchiveHashes } from "./legal-release";
import { parseLegalManifest } from "./legal-manifest";

const run = async () => {
  const sqlite = openReadOnlyDatabase();
  try {
    const active = sqlite.prepare("SELECT version, manifest_json FROM legal_releases WHERE active = 1").get() as { version: string; manifest_json: string } | undefined;
    if (!active) throw new LegalReleasePublishError("No active legal release is available for archive preflight.");
    let manifest;
    try { manifest = parseLegalManifest(JSON.parse(active.manifest_json)); }
    catch (error) { throw new LegalReleasePublishError(`Active legal release ${active.version} has an invalid manifest: ${error instanceof Error ? error.message : "unknown error"}`); }
    await verifyLegalArchiveHashes(manifest);
    console.log(JSON.stringify({ version: active.version, checked_documents: Object.keys(manifest.documents) }));
  } finally {
    sqlite.close();
  }
};

void run().catch((error: unknown) => {
  console.error(`Active legal archive preflight: FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
