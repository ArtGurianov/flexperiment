import { afterEach, describe, expect, it } from "vitest";
import { CommerceDomain } from "../src/domain";
import { emergencySalesPaused } from "../src/emergency-sales-gate";
import { MockProvider } from "../src/provider";
import { concurrencyFixture, type ConcurrencyFixture } from "./support/concurrency-fixture";

const fixtures: ConcurrencyFixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()?.close(); });

function setup() {
  const fixture = concurrencyFixture(); fixtures.push(fixture);
  return { fixture, domain: new CommerceDomain(fixture.primary, new MockProvider()) };
}

const pause = (db: ConcurrencyFixture["primary"]) =>
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1").run();
const reopen = (db: ConcurrencyFixture["primary"]) =>
  db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();

/**
 * The operator's absolute stop, asserted through `assertNewOrdersOpen` - the
 * composition boundary a customer actually reaches. A certification capability
 * may open the deployment fence and nothing else: this gate and the ordinary
 * business gates are both absolute, so this one's failure modes are the ones
 * that matter most.
 */
const ordersOpen = (domain: CommerceDomain) => {
  try { domain.assertNewOrdersOpen(); return true; } catch { return false; }
};

describe("emergency sales gate", () => {
  it("closes and reopens sales at the boundary customers reach", () => {
    const { fixture, domain } = setup();
    expect(ordersOpen(domain)).toBe(true);

    pause(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    reopen(fixture.primary);
    expect(ordersOpen(domain)).toBe(true);
  });

  it("reads a missing gate row as closed", () => {
    // The whole point of an emergency stop is that losing it is not the same
    // as clearing it. A gate whose row has been wiped - by a bad migration, a
    // restore, a manual mistake - must read as paused, because the alternative
    // is a database accident that silently opens sales.
    const { fixture, domain } = setup();
    fixture.primary.prepare("DELETE FROM emergency_sales_gate").run();

    expect(emergencySalesPaused(fixture.primary)).toBe(true);
    expect(ordersOpen(domain)).toBe(false);
  });

  it("survives a process restart, because the stop is durable and not in-process state", () => {
    const { fixture, domain } = setup();
    pause(fixture.primary);
    expect(ordersOpen(domain)).toBe(false);

    const reopened = fixture.restart();

    expect(ordersOpen(new CommerceDomain(reopened, new MockProvider()))).toBe(false);
    expect(reopened.prepare("SELECT sales_paused, revision FROM emergency_sales_gate WHERE singleton = 1").get()).toEqual({ sales_paused: 1, revision: 2 });
  });

  it("is observed identically by a second connection, with no per-connection caching", () => {
    // An operator pauses from one process; every other process must be shut
    // immediately, not at its next restart.
    const { fixture, domain } = setup();
    const other = fixture.connect();
    const otherDomain = new CommerceDomain(other, new MockProvider());
    expect(ordersOpen(domain)).toBe(true);

    pause(other);

    expect(ordersOpen(domain)).toBe(false);
    expect(ordersOpen(otherDomain)).toBe(false);
  });

  it("lets exactly one of two competing revision writers win", () => {
    const { fixture } = setup();
    const a = fixture.primary;
    const b = fixture.connect();
    const before = a.prepare("SELECT revision FROM emergency_sales_gate WHERE singleton = 1").get() as { revision: number };

    // Both read the same revision and both attempt the same compare-and-set.
    const cas = (db: ConcurrencyFixture["primary"]) => db
      .prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1 AND revision = ?")
      .run(before.revision).changes;

    expect([cas(a), cas(b)].sort()).toEqual([0, 1]);
    expect(a.prepare("SELECT revision FROM emergency_sales_gate WHERE singleton = 1").get()).toEqual({ revision: before.revision + 1 });
  });
});
