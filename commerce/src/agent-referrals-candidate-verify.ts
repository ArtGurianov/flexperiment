import { readFileSync } from "node:fs";
import {
  AgentReferralsCandidateError,
  reconstructAgentReferralsCandidateSha,
  type AgentReferralsCandidateCertificate,
} from "./agent-referrals-candidate";

const [certificatePath, trustedPatchSourceSha] = process.argv.slice(2);

if (!certificatePath || !trustedPatchSourceSha) {
  console.error("usage: agent-referrals-candidate-verify <certificate.json> <trusted-controller-sha>");
  process.exitCode = 2;
} else {
  try {
    const certificate = JSON.parse(readFileSync(certificatePath, "utf8")) as AgentReferralsCandidateCertificate;
    process.stdout.write(`${reconstructAgentReferralsCandidateSha(certificate, { trusted_patch_source_sha: trustedPatchSourceSha })}\n`);
  } catch (error) {
    console.error(error instanceof AgentReferralsCandidateError ? error.code : "AGENT_REFERRALS_CANDIDATE_RECONSTRUCTION_FAILED");
    process.exitCode = 1;
  }
}
