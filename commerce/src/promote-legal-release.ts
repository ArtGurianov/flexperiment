import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseUtcTimestamp } from "./utc-timestamp";

const version = process.env.COMMERCE_LEGAL_PROMOTION_VERSION;
const publishTime = process.env.COMMERCE_LEGAL_PROMOTION_PUBLISH_TIME;
if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error("COMMERCE_LEGAL_PROMOTION_VERSION must be a safe release version.");
if (!publishTime || publishTime === "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP" || Number.isNaN(parseUtcTimestamp(publishTime))) throw new Error("COMMERCE_LEGAL_PROMOTION_PUBLISH_TIME must be the authoritative publisher timestamp.");
const normalizedPublishTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(publishTime)
  ? `${publishTime.replace(" ", "T")}Z`
  : new Date(parseUtcTimestamp(publishTime)).toISOString().replace(".000Z", "Z");

const root = process.cwd();
const candidatePath = resolve(root, `commerce/legal/production-manifest.${version}.draft.json`);
const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as { version: string; publish_time?: string; documents: Record<string, { archive_url: string }> };
if (candidate.version !== version) throw new Error("Legal candidate version does not match the requested promotion version.");
candidate.publish_time = normalizedPublishTime;
writeFileSync(resolve(root, "commerce/legal/production-manifest.json"), `${JSON.stringify(candidate, null, 2)}\n`);

const destinations: Record<string, string> = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
};
for (const [id, document] of Object.entries(candidate.documents)) {
  const url = new URL(document.archive_url);
  const archivePath = resolve(root, `public${url.pathname}`);
  const destination = destinations[id];
  if (!destination || !archivePath.startsWith(resolve(root, "public/legal/archive"))) throw new Error(`Unexpected candidate legal document ${id}.`);
  writeFileSync(resolve(root, destination), readFileSync(archivePath));
}

const certificationPath = resolve(root, "certification.sh");
let certification = readFileSync(certificationPath, "utf8");
const certificationDefaults: Array<[string, string]> = [
  ["EXPECTED_LEGAL_VERSION", version],
  ["EXPECTED_PUBLIC_OFFER_SHA256", (candidate.documents.PUBLIC_OFFER as { sha256?: string }).sha256 ?? ""],
  ["EXPECTED_PRIVACY_POLICY_SHA256", (candidate.documents.PRIVACY_POLICY as { sha256?: string }).sha256 ?? ""],
  ["EXPECTED_PD_CONSENT_SHA256", (candidate.documents.PD_CONSENT as { sha256?: string }).sha256 ?? ""],
  ["EXPECTED_CHECKOUT_DISCLOSURE_SHA256", (candidate.documents.CHECKOUT_DISCLOSURE as { sha256?: string }).sha256 ?? ""],
];
for (const [name, value] of certificationDefaults) {
  if (!value) throw new Error(`Candidate is missing ${name}.`);
  const expression = new RegExp(`^${name}="\\$\\{${name}:-[^}]+\\}"$`, "m");
  if (!expression.test(certification)) throw new Error(`Unable to update ${name} certification default.`);
  certification = certification.replace(expression, `${name}="\${${name}:-${value}}"`);
}
writeFileSync(certificationPath, certification);

console.log(JSON.stringify({ version, publish_time: normalizedPublishTime, promoted_documents: Object.keys(destinations) }));
