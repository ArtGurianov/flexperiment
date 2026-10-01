import { describe, expect, it } from "vitest";
import {
  ANALYTICS_SETTINGS_OPEN_EVENT,
  applyAnalyticsConsentChoice,
  requestAnalyticsSettings,
} from "./analytics-consent-client";
import {
  clearMetrikaFirstPartyStorage,
  createMetrikaManager,
  enforceMetrikaDenied,
  syncMetrikaForRoute,
  type MetrikaEnvironment,
} from "./metrika";

describe("analytics consent transition", () => {
  it("dispatches the footer settings-open request without changing consent", () => {
    let eventType = "";
    requestAnalyticsSettings({
      dispatchEvent: (event) => {
        eventType = event.type;
        return true;
      },
    });
    expect(eventType).toBe(ANALYTICS_SETTINGS_OPEN_EVENT);
  });

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

  it.each(["/ticket", "/refund/confirm"])("cleans a1 storage on %s without creating a manager", (pathname) => {
    const cookies = new Set(["_ym_uid", "fx_ref", "fx_consent", "theme"]);
    const localStorage = new Set(["_ym123_lastHit", "_ym_retryReqs", "checkout", "theme"]);
    const sessionStorage = new Set(["_ym_debugger_state", "checkout"]);
    let storedConsent = "v1:a1";
    let factories = 0;
    const manager = syncMetrikaForRoute({
      consent: "ALLOWED",
      counterId: 123,
      manager: null,
      createManager: () => {
        factories += 1;
        throw new Error("sensitive route must not create a manager");
      },
      pathname,
      search: "",
    });

    applyAnalyticsConsentChoice("DENIED", {
      persist: () => { storedConsent = "v1:a0"; },
      revoke: () => enforceMetrikaDenied({
        counterId: 123,
        manager,
        environment: {
          setDisabled: () => undefined,
          cleanup: (counterId) => clearMetrikaFirstPartyStorage(counterId, {
            removeCookie: (key) => cookies.delete(key),
            removeLocalStorage: (key) => localStorage.delete(key),
            removeSessionStorage: (key) => sessionStorage.delete(key),
          }),
        },
      }),
      notify: () => undefined,
    });

    expect(storedConsent).toBe("v1:a0");
    expect(factories).toBe(0);
    expect(cookies).toEqual(new Set(["fx_ref", "fx_consent", "theme"]));
    expect(localStorage).toEqual(new Set(["checkout", "theme"]));
    expect(sessionStorage).toEqual(new Set(["checkout"]));
  });

  it.each(["/", "/kemerovo", "/ticket", "/refund/confirm"])("performs a0 cold-load cleanup on %s without manager, tag, init, or hit", (pathname) => {
    const events: string[] = [];
    let factories = 0;
    const manager = syncMetrikaForRoute({
      consent: "DENIED",
      counterId: 123,
      manager: null,
      createManager: () => {
        factories += 1;
        throw new Error("a0 must not create a manager");
      },
      pathname,
      search: "",
    });
    enforceMetrikaDenied({
      counterId: 123,
      manager,
      environment: {
        setDisabled: () => events.push("disabled"),
        cleanup: () => events.push("cleanup"),
      },
    });
    expect(factories).toBe(0);
    expect(events).toEqual(["disabled", "cleanup"]);
  });
});
