export const legalDocumentIds = ["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"] as const;
export type LegalDocumentId = (typeof legalDocumentIds)[number];
export type LegalDocumentEvidence = { document_id: LegalDocumentId; version: string; sha256: string; current_url: string; archive_url: string; checkout_relevant: true };
export type LegalManifest = { documents: Record<LegalDocumentId, LegalDocumentEvidence> };

export class LegalManifestError extends Error {}

const httpsUrl = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw new LegalManifestError(`Legal manifest ${field} must be a non-empty URL.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new LegalManifestError(`Legal manifest ${field} must be a URL.`); }
  if (url.protocol !== "https:") throw new LegalManifestError(`Legal manifest ${field} must use HTTPS.`);
  return url.toString();
};

export const parseLegalManifest = (raw: unknown): LegalManifest => {
  if (!raw || typeof raw !== "object" || !("documents" in raw) || !raw.documents || typeof raw.documents !== "object") throw new LegalManifestError("Legal manifest documents are missing.");
  const documents = raw.documents as Record<string, unknown>;
  const evidence = {} as Record<LegalDocumentId, LegalDocumentEvidence>;
  for (const id of legalDocumentIds) {
    const document = documents[id];
    if (!document || typeof document !== "object") throw new LegalManifestError(`Legal manifest document ${id} is missing.`);
    const fields = document as Record<string, unknown>;
    if (fields.document_id !== id || typeof fields.version !== "string" || !fields.version.trim() || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(fields.sha256) || fields.checkout_relevant !== true) throw new LegalManifestError(`Legal manifest document ${id} is invalid.`);
    const currentUrl = httpsUrl(fields.current_url, `${id}.current_url`);
    const archiveUrl = httpsUrl(fields.archive_url, `${id}.archive_url`);
    if (currentUrl === archiveUrl) throw new LegalManifestError(`Legal manifest document ${id} requires a distinct archive URL.`);
    evidence[id] = { document_id: id, version: fields.version.trim(), sha256: fields.sha256.toLowerCase(), current_url: currentUrl, archive_url: archiveUrl, checkout_relevant: true };
  }
  return { documents: evidence };
};

export const canonicalLegalManifest = (manifest: LegalManifest) => JSON.stringify({ documents: Object.fromEntries(legalDocumentIds.map((id) => [id, manifest.documents[id]])) });
