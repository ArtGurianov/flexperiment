import { readFileSync } from "node:fs";

export type BuildIdentity = {
  readonly schema: "flexperiment.build-identity/1";
  readonly service: string;
  readonly sourceCommit: string;
};

export function readBuildIdentity(service: string, environment: Readonly<Record<string, string | undefined>> = process.env): BuildIdentity {
  const filename = environment.BUILD_IDENTITY_FILE?.trim();
  if (!filename) {
    const sourceCommit = environment.SOURCE_COMMIT?.trim() ?? "development";
    if (sourceCommit !== "development" && !/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("SOURCE_COMMIT_INVALID");
    return { schema: "flexperiment.build-identity/1", service, sourceCommit };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filename, "utf8")); }
  catch { throw new Error("BUILD_IDENTITY_UNREADABLE"); }
  const candidate = parsed as Partial<BuildIdentity>;
  if (candidate.schema !== "flexperiment.build-identity/1" || candidate.service !== service
    || !/^[0-9a-f]{40}$/.test(candidate.sourceCommit ?? "")) throw new Error("BUILD_IDENTITY_INVALID");
  return candidate as BuildIdentity;
}
