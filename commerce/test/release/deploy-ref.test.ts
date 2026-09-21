import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProductionDeployRefStore } from "../../src/release/deploy-ref";

/**
 * Against a real git repository, because the thing under test is a lease that
 * git enforces. A fake would let the test assert that the right arguments were
 * assembled, which is not the same as the push being refused.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let origin: string;
let clone: string;
let first: string;
let second: string;
let store: ProductionDeployRefStore;

const commit = (message: string): string => {
  writeFileSync(join(clone, "file.txt"), `${message}\n`);
  git(clone, "add", "file.txt");
  git(clone, "commit", "-m", message);
  return git(clone, "rev-parse", "HEAD");
};

beforeEach(() => {
  origin = mkdtempSync(join(tmpdir(), "deploy-ref-origin-"));
  clone = mkdtempSync(join(tmpdir(), "deploy-ref-clone-"));
  git(origin, "init", "--bare", "--initial-branch=main", ".");
  git(clone, "init", "--initial-branch=main", ".");
  git(clone, "config", "user.email", "test@example.invalid");
  git(clone, "config", "user.name", "Test");
  git(clone, "remote", "add", "origin", origin);

  first = commit("first");
  second = commit("second");
  git(clone, "push", "origin", `${first}:refs/heads/production-deploy`);
  git(clone, "push", "origin", "main");
  store = new ProductionDeployRefStore({ cwd: clone });
});

describe("the production deploy pointer", () => {
  it("reads where the deployment system would deploy from", async () => {
    expect(await store.read()).toBe(first);
  });

  it("moves under a lease that matches", async () => {
    expect(await store.compareAndSet(first, second)).toBe(second);
    expect(await store.read()).toBe(second);
  });

  it("refuses when the pointer is no longer where the caller believed", async () => {
    // Another controller moved it. The loser has to re-read, not retry: a bare
    // force push would overwrite the winner and never learn it had.
    git(clone, "push", "--force", "origin", `${second}:refs/heads/production-deploy`);

    await expect(store.compareAndSet(first, first)).resolves.toBe(first);
    const third = commit("third");
    await expect(store.compareAndSet(first, third)).rejects.toThrow("DEPLOY_REF_LEASE_REFUSED");
    expect(await store.read()).toBe(second);
  });

  it("does not believe its own push: a pointer that did not move is not a move", async () => {
    // The one case a real repository cannot stage, so git is stubbed for it
    // alone: the push is accepted and the pointer is somewhere else anyway -
    // another controller landing between the two, or a remote that took the
    // write and served something older. Returning the sha the caller asked for
    // would hand a cutover a control-plane reading it never observed, and that
    // reading is half of what a safe abort is decided from.
    const third = commit("third");
    const stubbed = new ProductionDeployRefStore({
      cwd: clone,
      git: async (args) => {
        if (args[0] === "ls-remote") return `${third}\trefs/heads/production-deploy`;
        return "";
      },
    });

    await expect(stubbed.compareAndSet(first, second)).rejects.toThrow("DEPLOY_REF_NOT_MOVED");
    // The refusal names both shas, because an operator reading it has to know
    // which pointer is live before deciding anything.
    await expect(stubbed.compareAndSet(first, second)).rejects.toThrow(third);
  });

  it("refuses a target the remote cannot resolve", async () => {
    // Pushing a commit the remote does not have would leave the ref naming
    // nothing, and discovering that after the push is discovering it too late.
    await expect(store.compareAndSet(first, "c".repeat(40))).rejects.toThrow("DEPLOY_REF_GIT_FAILED");
    expect(await store.read()).toBe(first);
  });

  it("refuses anything that is not a commit sha", async () => {
    await expect(store.compareAndSet("HEAD", second)).rejects.toThrow("DEPLOY_REF_EXPECTED_INVALID");
    await expect(store.compareAndSet(first, "production-deploy")).rejects.toThrow("DEPLOY_REF_TARGET_INVALID");
    expect(await store.read()).toBe(first);
  });

  it("treats moving the pointer to where it already is as done", async () => {
    // The reconciling retry: a controller that pushed and lost its response
    // must be able to repeat the move and be told it succeeded.
    expect(await store.compareAndSet(first, first)).toBe(first);
    expect(await store.read()).toBe(first);
  });

  it("reports an absent pointer rather than inventing one", async () => {
    git(clone, "push", "--delete", "origin", "refs/heads/production-deploy");
    await expect(store.read()).rejects.toThrow("DEPLOY_REF_ABSENT");
  });

  it("moves back, which is what a rollback needs", async () => {
    await store.compareAndSet(first, second);
    expect(await store.compareAndSet(second, first)).toBe(first);
    expect(await store.read()).toBe(first);
  });
});
