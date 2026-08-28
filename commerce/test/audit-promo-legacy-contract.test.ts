import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scriptPath = resolve(repositoryRoot, "commerce/src/audit-promo-legacy-contract.ts");
const directories: string[] = [];

afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("promo legacy-contract audit", () => {
  it("audits a current percent agent default against reachable occurrence prices", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-promo-audit-"));
    directories.push(directory);
    const databasePath = resolve(directory, "commerce.sqlite3");
    const db = openDatabase(databasePath);
    migrate(db);
    const cityId = randomUUID();
    const agentId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'omsk', 'Омск')").run(cityId);
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Overflow test', '2027-01-01T10:00:00.000Z', '2027-01-01T11:00:00.000Z', 'Asia/Omsk', ?, 1, 'HIDDEN', 'CLOSED', 'CONFIRMED', 'Studio', 'Street 1')`)
      .run(randomUUID(), cityId, Number.MAX_SAFE_INTEGER);
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value)
      VALUES (?, 'percent-agent', 'Percent agent', 'Percent agent LLC', 'percent@example.test', 'SELF_EMPLOYED', '123456789012', 'A-1', 1, 'PERCENT', 10001)`)
      .run(agentId);
    db.close();

    let failure: { stdout: string } | undefined;
    try {
      execFileSync("node", ["--import", "tsx", scriptPath], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, COMMERCE_DATABASE_PATH: databasePath },
      });
    } catch (error) {
      failure = error as { stdout: string };
    }
    expect(failure).toBeDefined();
    expect(JSON.parse(failure!.stdout)).toMatchObject({
      findings: [{ kind: "REWARD_BASIS_POINTS_OUT_OF_RANGE", id: agentId }],
    });
  });
});
