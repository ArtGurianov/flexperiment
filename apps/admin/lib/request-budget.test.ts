import { describe, expect, it } from "vitest";
import { POLL_INTERVAL } from "./polling";
import { REQUEST_CEILING, rollingSixtySecondBudget, screenRequestsPerMinute, SCREEN_NAMES } from "./request-budget";

describe("admin-scope rolling 60s request budget", () => {
  it("stays under the 120 req/60s server limit (commerce/src/api.ts:231) for every pair of simultaneously visible screens, including two windows on the same screen", () => {
    for (const screenA of SCREEN_NAMES) {
      for (const screenB of SCREEN_NAMES) {
        const budget = rollingSixtySecondBudget(screenA, screenB);
        expect(budget, `${screenA} + ${screenB} = ${budget}`).toBeLessThanOrEqual(REQUEST_CEILING);
      }
    }
  });

  it("puts the worst-case pair (Orders + Occurrences, the two heaviest pollers) still comfortably under the ceiling", () => {
    const worst = rollingSixtySecondBudget("orders", "occurrences");
    expect(worst).toBeLessThanOrEqual(REQUEST_CEILING);
    expect(worst).toBeGreaterThan(0);
  });

  it("charges two browser windows on the same screen as genuinely double the polling rate (each window is its own QueryClient — TanStack only dedupes in-flight identical keys within one client, not across windows)", () => {
    // refunds: 6 req/min per window (10s interval) x2 windows = 12, plus
    // 2x its 1 active query for the focus burst, plus the fixed mutation
    // fan-out (4) + retry budget (2) + manual refresh (4) overhead terms.
    expect(screenRequestsPerMinute("refunds")).toBe(6);
    expect(rollingSixtySecondBudget("refunds", "refunds")).toBe(6 * 2 + 1 * 2 + 4 + 2 + 4);
  });

  it("keeps Cities and Audit at zero steady-state polling", () => {
    expect(POLL_INTERVAL.cities).toBe(false);
    expect(POLL_INTERVAL.audit).toBe(false);
    expect(screenRequestsPerMinute("cities")).toBe(0);
    expect(screenRequestsPerMinute("audit")).toBe(0);
  });
});
