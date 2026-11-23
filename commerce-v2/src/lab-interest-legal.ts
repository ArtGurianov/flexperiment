import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const document = z.string().min(1).max(32_768).refine(text => text.trim().length > 0);
const manifestSchema = z.strictObject({
  type: z.literal("LAB_INTEREST"),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  documents: z.strictObject({ lab_interest_consent: document, privacy: document }),
});

export type LabInterestManifest = {
  readonly consent: { readonly version: string; readonly text: string; readonly textSha256: string };
  readonly privacy: string;
};

/** The digest pins both exact documents. A missing or invalid release disables new signups only. */
export function parseLabInterestManifest(bytes: Buffer, expectedSha256: string): LabInterestManifest | undefined {
  if (bytes.byteLength > 256 * 1024 || digest(bytes) !== expectedSha256) return undefined;
  try {
    const { version, documents } = manifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    const text = documents.lab_interest_consent;
    return { consent: { version, text, textSha256: digest(text) }, privacy: documents.privacy };
  } catch { return undefined; }
}

export function loadLabInterestManifest(environment: NodeJS.ProcessEnv): LabInterestManifest | undefined {
  const path = environment.LAB_INTEREST_MANIFEST_PATH;
  const sha256 = environment.LAB_INTEREST_MANIFEST_SHA256;
  if (!path || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  try { return parseLabInterestManifest(readFileSync(path), sha256); }
  catch { return undefined; }
}
