import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalLegalManifest, parseLegalManifest } from "../../src/legal-manifest";
import { deriveCandidate, type CommitTreeReader } from "../../src/release/candidate-publication";
import { FileReleaseCandidateStore } from "../../src/release/candidate-store";
import { schemaInventoryExpectation } from "../../src/release/expectation";

const MAIN = "a".repeat(40);
const OLDER = "b".repeat(40);
const manifestJson = readFileSync("commerce/legal/production-manifest.json", "utf8");
const manifest = JSON.parse(manifestJson) as { version: string };
const expectedLegal = {
  version: manifest.version,
  sha256: createHash("sha256").update(canonicalLegalManifest(parseLegalManifest(JSON.parse(manifestJson)))).digest("hex"),
};

/** A tree whose contents the test controls, so a candidate's claims can disagree with it. */
const tree = (overrides: Partial<Record<string, string>> = {}): CommitTreeReader => ({
  async list() { return ["0001_launch_baseline.sql"]; },
  async read(_sha, path) {
    const body = overrides[path];
    if (body === undefined) return manifestJson;
    if (body === "") throw new Error("ENOENT");
    return body;
  },
  async isAncestor(ancestor, descendant) { return ancestor === descendant || ancestor === OLDER; },
  async resolve() { return MAIN; },
});

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "release-candidates-")); });

describe("deriving a candidate from the commit it is for", () => {
  it("reads the expectation out of that commit's own tree", async () => {
    const candidate = await deriveCandidate(tree(), { sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED" });

    // Nothing here was supplied by whoever asked for the publication. A
    // candidate that could claim an expectation its tree does not have is the
    // one way readiness could be made to admit the wrong release.
    expect(candidate).toEqual({
      id: MAIN, sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED",
      expectation: {
        schemaInventory: schemaInventoryExpectation(["0001_launch_baseline.sql"]),
        legalVersion: expectedLegal.version,
        legalManifestSha256: expectedLegal.sha256,
      },
    });
  });

  it("refuses a commit that is not on main", async () => {
    const detached: CommitTreeReader = { ...tree(), async isAncestor() { return false; } };
    await expect(deriveCandidate(detached, { sha: "c".repeat(40), releaseClass: "MAINTENANCE_REQUIRED" }))
      .rejects.toThrow("RELEASE_CANDIDATE_NOT_ON_MAIN");
  });

  it("never derives the retired launch baseline, even for main's tip", async () => {
    // The CLI hands over whatever string it was given.
    await expect(deriveCandidate(tree(), { sha: MAIN, releaseClass: "LAUNCH_BASELINE" as never }))
      .rejects.toThrow("LAUNCH_BASELINE_RETIRED");
    // An ancestor on main is publishable as an ordinary maintenance release.
    await expect(deriveCandidate(tree(), { sha: OLDER, releaseClass: "MAINTENANCE_REQUIRED" })).resolves.toMatchObject({ sha: OLDER });
  });

  it("refuses a tree whose legal manifest it cannot believe", async () => {
    await expect(deriveCandidate(tree({ "commerce/legal/production-manifest.json": "{}" }), { sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED" }))
      .rejects.toThrow("RELEASE_CANDIDATE_LEGAL_MANIFEST_INVALID");
    await expect(deriveCandidate(tree({ "commerce/legal/production-manifest.json": "" }), { sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED" }))
      .rejects.toThrow("RELEASE_CANDIDATE_LEGAL_MANIFEST_INVALID");
  });

  it("refuses a tree with no migrations rather than publishing an empty inventory", async () => {
    // An empty inventory is a digest that every schema-less runtime matches.
    const bare: CommitTreeReader = { ...tree(), async list() { return []; } };
    await expect(deriveCandidate(bare, { sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED" }))
      .rejects.toThrow("RELEASE_CANDIDATE_NO_MIGRATIONS");
  });
});

describe("a published candidate is written once", () => {
  const candidate = {
    id: MAIN, sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED" as const,
    expectation: { schemaInventory: schemaInventoryExpectation(["0001_launch_baseline.sql"]), legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64) },
  };

  it("round-trips, and republishing the same content succeeds", () => {
    const store = new FileReleaseCandidateStore(directory);
    expect(store.publish(candidate)).toMatchObject({ republished: false });
    expect(store.publish(candidate)).toMatchObject({ republished: true });
    expect(store.get(MAIN)).toEqual(candidate);
  });

  it("refuses a different release wearing a published commit's name", () => {
    const store = new FileReleaseCandidateStore(directory);
    store.publish(candidate);
    expect(() => store.publish({ ...candidate, expectation: { ...candidate.expectation, legalManifestSha256: "f".repeat(64) } }))
      .toThrow("RELEASE_CANDIDATE_ALREADY_PUBLISHED_DIFFERENTLY");
    expect(store.get(MAIN)?.releaseClass).toBe("MAINTENANCE_REQUIRED");
  });

  it("refuses a file that was edited after publication", () => {
    // Validated on the way out, not only on the way in. Deploy time is the last
    // moment discovering this still costs nothing.
    const store = new FileReleaseCandidateStore(directory);
    store.publish(candidate);
    writeFileSync(join(directory, `${MAIN}.json`), JSON.stringify({ ...candidate, sha: "d".repeat(40) }));
    expect(() => store.get(MAIN)).toThrow("RELEASE_CANDIDATE_INVALID");
  });

  it("will not let a candidate be named independently of its tree", () => {
    const store = new FileReleaseCandidateStore(directory);
    expect(() => store.publish({ ...candidate, id: "release-1" })).toThrow("RELEASE_CANDIDATE_INVALID");
    expect(() => store.get("../../etc/passwd")).toThrow("RELEASE_CANDIDATE_ID_INVALID");
  });

  it("answers undefined for a commit nobody published", () => {
    expect(new FileReleaseCandidateStore(directory).get("c".repeat(40))).toBeUndefined();
  });
});

describe("a launch candidate is history", () => {
  // Written as production's publication wrote it, before the class was retired.
  const launch = {
    id: MAIN, sha: MAIN, releaseClass: "LAUNCH_BASELINE",
    expectation: { schemaInventory: schemaInventoryExpectation(["0001_launch_baseline.sql"]), legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64) },
  };

  it("is read as history and refused as a release", () => {
    writeFileSync(join(directory, `${MAIN}.json`), `${JSON.stringify(launch, null, 2)}\n`);
    const store = new FileReleaseCandidateStore(directory);
    expect(store.readHistorical(MAIN)).toEqual(launch);
    expect(() => store.get(MAIN)).toThrow(`LAUNCH_BASELINE_RETIRED: ${MAIN}`);
  });

  it("is never published again, and cannot be republished as something else", () => {
    const store = new FileReleaseCandidateStore(directory);
    expect(() => store.publish(launch as never)).toThrow("RELEASE_CANDIDATE_INVALID: releaseClass");
    writeFileSync(join(directory, `${MAIN}.json`), `${JSON.stringify(launch, null, 2)}\n`);
    expect(() => store.publish({ ...launch, releaseClass: "MAINTENANCE_REQUIRED" }))
      .toThrow("RELEASE_CANDIDATE_ALREADY_PUBLISHED_DIFFERENTLY");
  });
});
