import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canBootstrapMetrika,
  clearMetrikaFirstPartyStorage,
  createMetrikaManager,
  enforceMetrikaDenied,
  installMetrikaQueue,
  METRIKA_COUNTER_ID,
  metrikaCounterId,
  syncMetrikaForRoute,
  type MetrikaEnvironment,
} from "./metrika";

type FakeMetrika = {
  environment: MetrikaEnvironment;
  commands: unknown[][];
  disabled: boolean[];
  cleanupCalls: Array<number | null>;
  injections: number;
  load: () => void;
};

function fakeMetrika(): FakeMetrika {
  const commands: unknown[][] = [];
  const disabled: boolean[] = [];
  const cleanupCalls: Array<number | null> = [];
  let onload: () => void = () => {};
  let injections = 0;
  return {
    environment: {
      injectTag: (handlers) => { injections += 1; onload = handlers.onload; },
      setDisabled: (_counterId, value) => { disabled.push(value); },
      command: (...command) => { commands.push(command); },
      cleanup: (counterId) => { cleanupCalls.push(counterId); },
    },
    commands,
    disabled,
    cleanupCalls,
    get injections() { return injections; },
    load: () => onload(),
  };
}

describe("Metrika consent manager", () => {
  it("does nothing before opt-in, validates public counter configuration, and keeps static HTML tag-free", () => {
    expect(metrikaCounterId()).toBe(METRIKA_COUNTER_ID);
    expect(METRIKA_COUNTER_ID).toBe(111866892);
    expect(metrikaCounterId("0")).toBeNull();
    expect(metrikaCounterId("100500")).toBe(100500);
    expect(canBootstrapMetrika("UNDECIDED", 123)).toBe(false);
    expect(canBootstrapMetrika("DENIED", 123)).toBe(false);
    expect(canBootstrapMetrika("ALLOWED", null)).toBe(false);
    expect(canBootstrapMetrika("ALLOWED", 123)).toBe(true);
    const layout = readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).not.toContain("mc.yandex.ru");
    expect(layout).not.toContain("<noscript");
  });

  it("uses the official queue timestamp and preserves an existing ym queue", () => {
    const target: { ym?: ReturnType<typeof installMetrikaQueue> } = {};
    const queue = installMetrikaQueue(target, 42);
    queue(123, "hit", "/");
    expect(queue.l).toBe(42);
    expect(queue.a).toEqual([[123, "hit", "/"]]);
    expect(installMetrikaQueue(target, 99)).toBe(queue);
    expect(queue.l).toBe(42);
  });

  it("injects and initializes exactly once after opt-in, then emits one safe first hit", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.observe("/kemerovo", "?fx_ref=v1%3Aagent&utm_source=vk&order=secret");
    expect(fake.injections).toBe(0);
    expect(fake.commands).toEqual([]);

    manager.enable();
    manager.enable();
    expect(fake.injections).toBe(1);
    expect(fake.commands).toEqual([]);
    fake.load();

    expect(fake.commands).toEqual([
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/kemerovo?utm_source=vk"],
    ]);
    manager.observe("/kemerovo", "?utm_source=vk#not-observed");
    expect(fake.commands).toHaveLength(2);
    manager.observe("/novosibirsk", "?utm_campaign=fall");
    expect(fake.commands.at(-1)).toEqual([123, "hit", "/novosibirsk?utm_campaign=fall"]);
  });

  it("prevents an a1 direct load on every sensitive route from creating a manager or tag", () => {
    for (const pathname of ["/ticket", "/ticket/view", "/refund", "/refund/confirm", "/payment/success", "/admin"]) {
      const fake = fakeMetrika();
      let factories = 0;
      const manager = syncMetrikaForRoute({
        consent: "ALLOWED",
        counterId: 123,
        manager: null,
        createManager: (counterId) => {
          factories += 1;
          return createMetrikaManager(counterId, fake.environment);
        },
        pathname,
        search: "",
      });
      expect(manager).toBeNull();
      expect(factories).toBe(0);
      expect(fake.injections).toBe(0);
      expect(fake.commands).toEqual([]);
    }
  });

  it("suspends on an eligible-to-sensitive navigation and re-enables once on return", () => {
    const fake = fakeMetrika();
    let manager = syncMetrikaForRoute({
      consent: "ALLOWED", counterId: 123, manager: null,
      createManager: (counterId) => createMetrikaManager(counterId, fake.environment),
      pathname: "/kemerovo", search: "",
    });
    fake.load();
    syncMetrikaForRoute({
      consent: "ALLOWED", counterId: 123, manager,
      createManager: () => { throw new Error("sensitive route must not create a manager"); },
      pathname: "/ticket", search: "",
    });
    manager = syncMetrikaForRoute({
      consent: "ALLOWED", counterId: 123, manager,
      createManager: () => { throw new Error("existing manager should be reused"); },
      pathname: "/tomsk", search: "?utm_source=vk",
    });
    expect(fake.commands).toEqual([
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/kemerovo"],
      [123, "destruct"],
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/tomsk?utm_source=vk"],
    ]);
  });

  it("keeps a loading tag inert when revoke wins before its callback", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.observe("/", "");
    manager.enable();
    manager.revoke();
    fake.load();
    expect(fake.commands).toEqual([]);
    expect(fake.cleanupCalls).toEqual([123]);
    expect(fake.disabled).toEqual([false, true]);
  });

  it("makes approved goals a no-op before initialization and after revoke", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.reachGoal("city_view");
    manager.enable();
    manager.reachGoal("checkout_start");
    expect(fake.commands).toEqual([]);

    fake.load();
    manager.reachGoal("city_view");
    expect(fake.commands.at(-1)).toEqual([123, "reachGoal", "city_view"]);

    manager.revoke();
    manager.reachGoal("payment_redirect");
    expect(fake.commands.at(-1)).toEqual([123, "destruct"]);
  });

  it("cleans only known Metrika first-party keys and leaves functional state intact", () => {
    const cookies = new Set([
      "_ym_metrika_enabled", "_ym_isad", "_ym_uid", "_ym_fa", "_ym_d", "_ym_ucs", "_ym_hostIndex",
      "fx_ref", "fx_consent", "theme",
    ]);
    const localStorage = new Set([
      "_ym123_lastHit", "_ym123_lsid", "_ym123_reqNum", "_ym_retryReqs", "_ym_uid", "_ym_hide_phones", "zz",
      "checkout", "theme",
    ]);
    const sessionStorage = new Set(["_ym_debugger_state", "_ym_turbo_uid", "checkout", "ticket"]);
    clearMetrikaFirstPartyStorage(123, {
      removeCookie: (key) => cookies.delete(key),
      removeLocalStorage: (key) => localStorage.delete(key),
      removeSessionStorage: (key) => sessionStorage.delete(key),
    });
    expect(cookies).toEqual(new Set(["fx_ref", "fx_consent", "theme"]));
    expect(localStorage).toEqual(new Set(["checkout", "theme"]));
    expect(sessionStorage).toEqual(new Set(["checkout", "ticket"]));
  });

  it("cleans generic documented state without a configured counter but retains unknown counter-specific state", () => {
    const localStorage = new Set(["_ym123_lastHit", "_ym_retryReqs", "_ym_uid", "zz", "checkout"]);
    const sessionStorage = new Set(["_ym_debugger_state", "_ym_turbo_uid", "checkout"]);
    clearMetrikaFirstPartyStorage(null, {
      removeCookie: () => undefined,
      removeLocalStorage: (key) => localStorage.delete(key),
      removeSessionStorage: (key) => sessionStorage.delete(key),
    });
    expect(localStorage).toEqual(new Set(["_ym123_lastHit", "checkout"]));
    expect(sessionStorage).toEqual(new Set(["checkout"]));
  });

  it("enforces denial and cleanup even when no manager exists", () => {
    const calls: Array<string | number> = [];
    enforceMetrikaDenied({
      counterId: 123,
      manager: null,
      environment: {
        setDisabled: (id, value) => calls.push(id, String(value)),
        cleanup: (id) => calls.push(`cleanup:${id}`),
      },
    });
    expect(calls).toEqual([123, "true", "cleanup:123"]);
  });

  it("uses only the latest safe navigation when loading completes", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.enable();
    manager.observe("/kemerovo", "?utm_source=vk");
    manager.observe("/ticket", "");
    manager.observe("/tomsk", "?utm_source=vk");
    fake.load();
    expect(fake.commands).toEqual([
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/tomsk?utm_source=vk"],
    ]);
  });
});
