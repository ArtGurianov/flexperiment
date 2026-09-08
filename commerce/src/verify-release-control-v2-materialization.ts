import { readFileSync } from "node:fs";
import {
  buildReleasePacket,
  canonicalReleasePacket,
  validateReleasePacket,
} from "./release-control-v2";
import { reconstructReleaseControlV2Candidate } from "./release-control-v2-materializer";

const path = process.argv[2];
if (!path) throw new Error("RELEASE_CONTROL_V2_MATERIALIZATION_PACKET_REQUIRED");

const packet = validateReleasePacket(JSON.parse(readFileSync(path, "utf8")));
const materialized = reconstructReleaseControlV2Candidate(process.cwd(), packet.materialization);
const rebuilt = buildReleasePacket({
  base: {
    sha: materialized.certificate.production_base_sha,
    tree: materialized.certificate.production_base_tree,
  },
  candidate: {
    sha: materialized.certificate.candidate_sha,
    tree: materialized.certificate.candidate_tree,
  },
  changed_paths: materialized.certificate.canonical_path_manifest,
  activation_required: packet.activation_required,
  materialization: materialized.certificate,
});
if (canonicalReleasePacket(packet) !== canonicalReleasePacket(rebuilt)) {
  throw new Error("RELEASE_CONTROL_V2_MATERIALIZATION_PACKET_MISMATCH");
}
process.stdout.write(`${canonicalReleasePacket(rebuilt)}\n`);
