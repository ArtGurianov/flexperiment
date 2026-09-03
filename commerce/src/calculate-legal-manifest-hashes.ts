import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalLegalManifest, parseLegalManifest } from "./legal-manifest";

/**
 * The one checked-in executable for the legal-manifest hash pair
 * ("<source_sha256> <canonical_sha256>") - used identically by the Epoch A
 * prepare preflight workflow and by its own regression test, so there is
 * exactly one implementation of this calculation, not a workflow copy and
 * a test copy.
 *
 * Replaces a fragile inline `node --import tsx --input-type=module -e
 * '...'` ESM eval whose named import of canonicalLegalManifest/
 * parseLegalManifest from a dynamically-evaluated -e string was
 * unreliable in this repo's sandboxed tsx setup. A checked-in file with a
 * normal, statically-resolved import has none of that fragility, and runs
 * via the same `node --import tsx <path> <args>` convention already used
 * throughout commerce/src for one-shot release-control scripts.
 *
 * Prints EXACTLY "<source_sha256> <canonical_sha256>\n" to stdout on
 * success and nothing else - never a partial or malformed line on
 * failure. Any failure (missing manifest argument, unreadable file,
 * invalid JSON, invalid legal manifest per parseLegalManifest) exits
 * nonzero with empty stdout, so a caller can trust that a zero exit
 * always means the printed pair is real.
 */

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error("Usage: calculate-legal-manifest-hashes.ts <manifest-path>");
  process.exit(1);
}

try {
  const raw = readFileSync(manifestPath);
  const manifest = parseLegalManifest(JSON.parse(raw.toString("utf8")));
  const canonical = canonicalLegalManifest(manifest);
  const sourceSha256 = createHash("sha256").update(raw).digest("hex");
  const canonicalSha256 = createHash("sha256").update(canonical).digest("hex");
  process.stdout.write(`${sourceSha256} ${canonicalSha256}\n`);
} catch (error) {
  console.error(`Legal manifest hash calculation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
