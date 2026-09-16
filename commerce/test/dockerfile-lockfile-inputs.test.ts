import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A patched dependency is an input to `pnpm install`, not to the build that
 * follows it. The lockfile names the patch file and pnpm hashes it during a
 * frozen install, and the config that declares it lives in
 * `pnpm-workspace.yaml` — so an image that copies only the manifests fails
 * before a single source file has been copied, with an ENOENT or an
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH depending on which half is missing.
 *
 * That is exactly how the 2026-09-16 production deploy of a9ea010 failed, on
 * all three services at once, having already advanced `production-deploy`.
 * Nothing in CI builds these images, so this is the only place the coupling
 * between the lockfile and the Dockerfiles is checked at all.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");

const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8");

/** Patch paths the lockfile requires, e.g. `patches/foo@1.0.0.patch`. */
const patchPaths = [...read("pnpm-lock.yaml").matchAll(/^\s+path:\s*(patches\/\S+)$/gm)]
  .map((match) => match[1]);

/** Every root Dockerfile whose dependency stage runs a frozen install. */
const dockerfiles = readdirSync(REPO_ROOT)
  .filter((name) => name.startsWith("Dockerfile"))
  .map((name) => ({ name, lines: read(name).split("\n") }))
  .map((file) => ({
    ...file,
    installAt: file.lines.findIndex((line) =>
      /^RUN\s+.*\bpnpm\s+install\b.*--frozen-lockfile/.test(line),
    ),
  }))
  .filter((file) => file.installAt !== -1);

describe("Dockerfiles carry every input a frozen pnpm install reads", () => {
  it("finds the images that install from the lockfile", () => {
    // Guards the guard: a rename that emptied this list would make every
    // assertion below vacuous rather than failing.
    expect(dockerfiles.length).toBeGreaterThan(0);
  });

  // There are no patched dependencies right now — the one this was written for
  // was removed with the package that needed it. The check stays because the
  // coupling is invisible until a deploy fails: adding a patch back without
  // touching the Dockerfiles reproduces the same outage exactly.
  it.runIf(patchPaths.length > 0).each(dockerfiles.map((f) => [f.name, f] as const))(
    "%s copies the patch directory and the workspace config before installing",
    (_name, file) => {
      const beforeInstall = file.lines.slice(0, file.installAt).join("\n");
      const copied = [...beforeInstall.matchAll(/^COPY\s+(.+)$/gm)]
        .map((match) => match[1])
        .join(" ");

      for (const patchPath of patchPaths) {
        const directory = patchPath.split("/")[0];
        expect(
          copied.includes(`${directory}/`) || copied.split(/\s+/).includes(directory),
          `${file.name} must COPY ${directory}/ before its frozen install; the lockfile requires ${patchPath}`,
        ).toBe(true);
      }

      expect(
        copied.includes("pnpm-workspace.yaml"),
        `${file.name} must COPY pnpm-workspace.yaml before its frozen install: it declares patchedDependencies, and without it pnpm rejects the lockfile as mismatched`,
      ).toBe(true);
    },
  );
});
