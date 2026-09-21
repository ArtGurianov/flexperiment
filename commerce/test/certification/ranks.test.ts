import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CERTIFICATION_PHASE_ORDER, CLEANUP_DIRECTION_ORDER, sqlMembership, sqlRankLadder,
} from "../../src/certification/ranks";
import { directionAtLeast, phaseAtLeast } from "../../src/certification/run";

/**
 * Both orders exist in TypeScript and in SQL, and two spellings of one order
 * can drift. The drift would be silent in the worst direction: a phase the
 * application believes is later than another while the database believes the
 * opposite is a regression the guard waves through.
 *
 * The frozen baseline is not regenerated from the contract. It is compared
 * against it.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const sql = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => ({ name, body: readFileSync(join(MIGRATIONS, name), "utf8") }));

/** Every `CASE <expr> WHEN 'X' THEN n ... END` in a migration, as the mapping it encodes. */
const ladders = (body: string): { expression: string; ranks: Record<string, number> }[] =>
  [...body.matchAll(/CASE\s+(NEW|OLD)\.(\w+)\s+((?:WHEN\s+'[A-Z_]+'\s+THEN\s+\d+\s*)+)END/g)].map((match) => ({
    expression: `${match[1]}.${match[2]}`,
    ranks: Object.fromEntries([...match[3].matchAll(/WHEN\s+'([A-Z_]+)'\s+THEN\s+(\d+)/g)].map((pair) => [pair[1], Number(pair[2])])),
  }));

const contractRanks = (order: readonly string[]) => Object.fromEntries(order.map((value, rank) => [value, rank]));

describe("one order, two languages", () => {
  it("finds the ladders it is meant to be checking", () => {
    // A test that silently matched nothing would pass forever. Both orders are
    // compared in the baseline's run-transition guard.
    const found = sql.flatMap(({ body }) => ladders(body));
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found.map((ladder) => ladder.expression)).toEqual(
      expect.arrayContaining(["NEW.phase", "OLD.phase", "NEW.direction", "OLD.direction"]),
    );
  });

  it("agrees with every rank ladder in every migration", () => {
    const phases = contractRanks(CERTIFICATION_PHASE_ORDER);
    const directions = contractRanks(CLEANUP_DIRECTION_ORDER);
    for (const { name, body } of sql) {
      for (const ladder of ladders(body)) {
        const expected = ladder.expression.endsWith(".phase") ? phases : directions;
        expect(ladder.ranks, `${name}: ${ladder.expression}`).toEqual(expected);
      }
    }
  });

  it("agrees with the members every CHECK enumerates", () => {
    // A value the database accepts but the contract has never heard of has no
    // rank, so every comparison involving it answers with NULL - and a guard
    // whose condition is NULL does not fire.
    const body = sql.map((file) => file.body).join("\n");
    expect(body).toContain(sqlMembership("direction", CLEANUP_DIRECTION_ORDER));
    for (const phase of CERTIFICATION_PHASE_ORDER) expect(body).toContain(`'${phase}'`);
    const declared = [...body.matchAll(/phase TEXT NOT NULL CHECK \(phase IN \(([^)]+)\)\)/g)]
      .flatMap((match) => [...match[1].matchAll(/'([A-Z_]+)'/g)].map((pair) => pair[1]));
    expect(declared).toEqual([...CERTIFICATION_PHASE_ORDER]);
  });

  it("builds a fragment a future migration can use rather than retyping one", () => {
    expect(sqlRankLadder("NEW.direction", CLEANUP_DIRECTION_ORDER))
      .toBe("CASE NEW.direction WHEN 'NORMAL' THEN 0 WHEN 'FINANCIAL_EFFECT_POSSIBLE' THEN 1 WHEN 'CLEANUP_STARTED' THEN 2 WHEN 'CATALOGUE_CLEAN' THEN 3 END");
    // And what it builds is what the baseline already contains.
    expect(sql.map((file) => file.body).join("\n")).toContain(sqlRankLadder("NEW.direction", CLEANUP_DIRECTION_ORDER));
  });

  it("is the same order the predicates use", () => {
    // The contract is not a separate opinion held beside the code: these are
    // the functions the machine actually decides with.
    for (let index = 1; index < CERTIFICATION_PHASE_ORDER.length; index += 1) {
      expect(phaseAtLeast(CERTIFICATION_PHASE_ORDER[index], CERTIFICATION_PHASE_ORDER[index - 1])).toBe(true);
      expect(phaseAtLeast(CERTIFICATION_PHASE_ORDER[index - 1], CERTIFICATION_PHASE_ORDER[index])).toBe(false);
    }
    for (let index = 1; index < CLEANUP_DIRECTION_ORDER.length; index += 1) {
      expect(directionAtLeast(CLEANUP_DIRECTION_ORDER[index], CLEANUP_DIRECTION_ORDER[index - 1])).toBe(true);
      expect(directionAtLeast(CLEANUP_DIRECTION_ORDER[index - 1], CLEANUP_DIRECTION_ORDER[index])).toBe(false);
    }
  });
});
