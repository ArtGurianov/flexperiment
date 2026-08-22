import { describe, expect, it } from "vitest";
import { applyAnalyticsConsentChoice } from "./analytics-consent-client";
import { createMetrikaManager, type MetrikaEnvironment } from "./metrika";

describe("analytics consent transition", () => {
  it("persists denial and revokes a loading manager before any later React effect", () => {
    const events: string[] = [];
    const commands: unknown[][] = [];
    let onload: () => void = () => {};
    const environment: MetrikaEnvironment = {
      injectTag: (handlers) => { onload = handlers.onload; },
      setDisabled: () => undefined,
      command: (...command) => { commands.push(command); },
      cleanup: () => undefined,
    };
    const manager = createMetrikaManager(123, environment);
    manager.observe("/", "");
    manager.enable();

    applyAnalyticsConsentChoice("DENIED", {
      persist: () => events.push("persist"),
      revoke: () => { events.push("revoke"); manager.revoke(); },
      notify: () => events.push("notify"),
    });
    onload();

    expect(events).toEqual(["persist", "revoke", "notify"]);
    expect(commands).toEqual([]);
  });

  it("does not revoke a counter when consent is granted", () => {
    const events: string[] = [];
    applyAnalyticsConsentChoice("ALLOWED", {
      persist: () => events.push("persist"),
      revoke: () => events.push("revoke"),
      notify: () => events.push("notify"),
    });
    expect(events).toEqual(["persist", "notify"]);
  });
});
