import { createHash } from "node:crypto";

export const RELEASE_CONTROL_V2_MATERIALIZER_VERSION = "release-control-v2-materializer-v1" as const;
export const RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION = "release-control-v2-materialization-v1" as const;
export const RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION = "git-diff-binary-full-index-no-ext-diff-no-textconv-no-renames-myers-v1" as const;

export const RELEASE_CONTROL_V2_COMMIT_METADATA = {
  author_name: "Flexperiment Release Control",
  author_email: "release-control@flexperiment.invalid",
  author_date: "2000-01-01T00:00:00+00:00",
  committer_name: "Flexperiment Release Control",
  committer_email: "release-control@flexperiment.invalid",
  committer_date: "2000-01-01T00:00:00+00:00",
} as const;

const SHA = /^[a-f0-9]{40}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalManifest = (paths: readonly string[]) => [...new Set(paths)].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
const isManifestPath = (path: string) => Boolean(path) && !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes("..");
const fail = (code: string): never => { throw new Error(code); };

export type ReleaseControlV2CommitMetadata = {
  readonly author_name: string;
  readonly author_email: string;
  readonly author_date: string;
  readonly committer_name: string;
  readonly committer_email: string;
  readonly committer_date: string;
  readonly message: string;
};

export type ReleaseControlV2MaterializationCertificate = {
  readonly schema_version: typeof RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION;
  readonly production_base_sha: string;
  readonly production_base_tree: string;
  readonly source_commit_sha: string;
  readonly source_commit_tree: string;
  readonly source_parent_sha: string;
  readonly source_parent_tree: string;
  readonly canonical_path_manifest: readonly string[];
  readonly path_manifest_sha256: string;
  readonly patch_format_version: typeof RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION;
  readonly patch_sha256: string;
  readonly candidate_sha: string;
  readonly candidate_tree: string;
  readonly candidate_parent_sha: string;
  readonly commit_metadata: ReleaseControlV2CommitMetadata;
  readonly materializer_version: typeof RELEASE_CONTROL_V2_MATERIALIZER_VERSION;
};

export const releaseControlV2MaterializationMessage = (base: string, parent: string, source: string) => [
  "Release Control v2 materialized candidate",
  "",
  `source: ${source}`,
  `source-parent: ${parent}`,
  `production-base: ${base}`,
  `materializer: ${RELEASE_CONTROL_V2_MATERIALIZER_VERSION}`,
].join("\n");

export const validateReleaseControlV2MaterializationCertificate = (value: unknown): ReleaseControlV2MaterializationCertificate => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MATERIALIZATION_CERTIFICATE_INVALID");
  const certificate = value as Record<string, unknown>;
  const expectedKeys = [
    "schema_version", "production_base_sha", "production_base_tree", "source_commit_sha", "source_commit_tree",
    "source_parent_sha", "source_parent_tree", "canonical_path_manifest", "path_manifest_sha256", "patch_format_version",
    "patch_sha256", "candidate_sha", "candidate_tree", "candidate_parent_sha", "commit_metadata", "materializer_version",
  ].sort();
  const actualKeys = Object.keys(certificate).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) fail("MATERIALIZATION_CERTIFICATE_SCHEMA_INVALID");
  if (certificate.schema_version !== RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION ||
    certificate.patch_format_version !== RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION ||
    certificate.materializer_version !== RELEASE_CONTROL_V2_MATERIALIZER_VERSION) fail("MATERIALIZATION_CERTIFICATE_VERSION_INVALID");
  for (const key of ["production_base_sha", "production_base_tree", "source_commit_sha", "source_commit_tree", "source_parent_sha", "source_parent_tree", "candidate_sha", "candidate_tree", "candidate_parent_sha"] as const) {
    if (typeof certificate[key] !== "string" || !SHA.test(certificate[key])) fail("MATERIALIZATION_CERTIFICATE_IDENTITY_INVALID");
  }
  for (const key of ["path_manifest_sha256", "patch_sha256"] as const) {
    if (typeof certificate[key] !== "string" || !/^[a-f0-9]{64}$/.test(certificate[key])) fail("MATERIALIZATION_CERTIFICATE_HASH_INVALID");
  }
  if (certificate.candidate_parent_sha !== certificate.production_base_sha ||
    certificate.production_base_sha === certificate.source_commit_sha ||
    certificate.production_base_sha === certificate.source_parent_sha ||
    certificate.source_commit_sha === certificate.source_parent_sha) fail("MATERIALIZATION_CERTIFICATE_RELATIONSHIP_INVALID");
  if (!Array.isArray(certificate.canonical_path_manifest) || certificate.canonical_path_manifest.some((path) => typeof path !== "string" || !isManifestPath(path))) {
    fail("MATERIALIZATION_CERTIFICATE_MANIFEST_INVALID");
  }
  const manifest = canonicalManifest(certificate.canonical_path_manifest as string[]);
  if (JSON.stringify(manifest) !== JSON.stringify(certificate.canonical_path_manifest) || hash(JSON.stringify(manifest)) !== certificate.path_manifest_sha256) {
    fail("MATERIALIZATION_CERTIFICATE_MANIFEST_INVALID");
  }
  if (!certificate.commit_metadata || typeof certificate.commit_metadata !== "object" || Array.isArray(certificate.commit_metadata)) fail("MATERIALIZATION_CERTIFICATE_METADATA_INVALID");
  const metadata = certificate.commit_metadata as Record<string, unknown>;
  const metadataKeys = ["author_name", "author_email", "author_date", "committer_name", "committer_email", "committer_date", "message"].sort();
  if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(metadataKeys)) fail("MATERIALIZATION_CERTIFICATE_METADATA_INVALID");
  const expectedMetadata = {
    ...RELEASE_CONTROL_V2_COMMIT_METADATA,
    message: releaseControlV2MaterializationMessage(certificate.production_base_sha as string, certificate.source_parent_sha as string, certificate.source_commit_sha as string),
  };
  if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)) fail("MATERIALIZATION_CERTIFICATE_METADATA_INVALID");
  return certificate as unknown as ReleaseControlV2MaterializationCertificate;
};
