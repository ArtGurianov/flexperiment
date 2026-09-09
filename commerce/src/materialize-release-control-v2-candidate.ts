import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildReleasePacket,
  canonicalReleasePacket,
} from "./release-control-v2";
import {
  materializeReleaseControlV2Candidate,
} from "./release-control-v2-materializer";

type Arguments = {
  readonly productionBase: string;
  readonly sourceCommit: string;
  readonly out: string;
};

const parseArguments = (argv: readonly string[]): Arguments => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name || !value || !["--production-base", "--source-commit", "--out"].includes(name) || values.has(name)) {
      throw new Error("RELEASE_CONTROL_V2_MATERIALIZE_ARGUMENTS_INVALID");
    }
    values.set(name, value);
  }
  const productionBase = values.get("--production-base");
  const sourceCommit = values.get("--source-commit");
  const out = values.get("--out");
  if (!productionBase || !sourceCommit || !out || values.size !== 3) throw new Error("RELEASE_CONTROL_V2_MATERIALIZE_ARGUMENTS_INVALID");
  return { productionBase, sourceCommit, out };
};

const args = parseArguments(process.argv.slice(2));
const materialized = materializeReleaseControlV2Candidate(process.cwd(), {
  production_base_sha: args.productionBase,
  source_commit_sha: args.sourceCommit,
});
const { certificate } = materialized;
const packet = buildReleasePacket({
  base: { sha: certificate.production_base_sha, tree: certificate.production_base_tree },
  candidate: { sha: certificate.candidate_sha, tree: certificate.candidate_tree },
  changed_paths: certificate.canonical_path_manifest,
  activation_required: false,
  materialization: certificate,
});
const out = resolve(args.out);
mkdirSync(out, { recursive: false });
writeFileSync(resolve(out, "canonical.patch"), materialized.canonical_patch);
writeFileSync(resolve(out, "materialization.json"), `${JSON.stringify(certificate)}\n`);
writeFileSync(resolve(out, "release-packet.json"), `${canonicalReleasePacket(packet)}\n`);
process.stdout.write(`${canonicalReleasePacket(packet)}\n`);
