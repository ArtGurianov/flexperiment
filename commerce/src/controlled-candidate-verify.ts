import { readFileSync } from "node:fs";
import {
  ControlledCandidateError,
  reconstructControlledCandidateSha,
  type ControlledCandidateCertificate,
} from "./controlled-candidate";

const [certificatePath, trustedPatchSourceSha] = process.argv.slice(2);

if (!certificatePath || !trustedPatchSourceSha) {
  console.error("usage: controlled-candidate-verify <certificate.json> <trusted-controller-sha>");
  process.exitCode = 2;
} else {
  try {
    const certificate = JSON.parse(readFileSync(certificatePath, "utf8")) as ControlledCandidateCertificate;
    process.stdout.write(`${reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: trustedPatchSourceSha })}\n`);
  } catch (error) {
    console.error(error instanceof ControlledCandidateError ? error.code : "CONTROLLED_CANDIDATE_RECONSTRUCTION_FAILED");
    process.exitCode = 1;
  }
}
