import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrationSha256, readV2MigrationLock, readV2Migrations } from "../../commerce-v2/src/migration-integrity";

const directory = "commerce-v2/migrations";
const lockPath = `${directory}/migration.lock`;

export function checkV2MigrationHistory(root = process.cwd()) {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  const fail = (message: string): never => { throw new Error(`V2_MIGRATION_HISTORY_INVALID: ${message}`); };
  // Missing/shallow history is a failure even locally. A parent-only comparison
  // would accept SQL and lock rewritten together, or a rewrite later reverted.
  if (git("rev-parse", "--is-shallow-repository").trim() !== "false") fail("full Git history required (fetch-depth: 0)");
  const current = new Map(readV2Migrations(join(root, directory)).map(({ version, sha256 }) => [version, sha256]));
  const revisions = git("log", "--full-history", "--format=%H", "HEAD", "--", directory).trim().split("\n").filter(Boolean);
  if (!revisions.length) fail("no committed migration history");
  const checkedBlobs = new Set<string>();
  for (const revision of revisions) {
    const tree = git("ls-tree", "-r", "-z", revision, "--", directory).split("\0").filter(Boolean);
    for (const entry of tree) {
      const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match) fail(`unsupported tree entry at ${revision}: ${entry}`);
      const [, mode, blob, path] = match!;
      if (!path.endsWith(".sql") && path !== lockPath) continue;
      if (mode !== "100644") fail(`migration must be a regular file: ${path}`);
      if (checkedBlobs.has(`${path}:${blob}`)) continue;
      checkedBlobs.add(`${path}:${blob}`);
      if (path === lockPath) {
        const historical = readV2MigrationLock(git("cat-file", "blob", blob));
        for (const [version, digest] of Object.entries(historical)) {
          if (current.get(version) !== digest) fail(`committed lock entry changed or removed: ${version} (${revision})`);
        }
      } else {
        const version = path.slice(directory.length + 1);
        const bytes = execFileSync("git", ["cat-file", "blob", blob], {
          cwd: root, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 16 * 1024 * 1024,
        });
        if (current.get(version) !== migrationSha256(bytes)) fail(`committed SQL changed or removed: ${version} (${revision})`);
      }
    }
  }
  // Inspect deletion commits too, including delete/restore pairs with identical
  // final bytes. -m exposes changes against both parents of merge commits.
  // Disable rename detection so a temporary rename also deletes the protected
  // original path, even when a later commit restores its exact name and bytes.
  const deleted = git("log", "--full-history", "-m", "--no-renames", "--format=", "--name-only", "--diff-filter=D", "HEAD", "--", directory)
    .split("\n").filter((path) => path.endsWith(".sql") || path === lockPath);
  if (deleted.length) fail(`committed migration/lock deletion: ${deleted[0]}`);
  return { migrations: current.size, revisions: revisions.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkV2MigrationHistory();
    console.log(`V2 migration integrity PASS: ${result.migrations} migrations, ${result.revisions} historical trees`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
