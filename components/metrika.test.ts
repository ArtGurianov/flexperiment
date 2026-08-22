import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMetrikaManager,
  canBootstrapMetrika,
  metrikaCounterId,
  type MetrikaEnvironment,
} from "./metrika";

type FakeMetrika = {
  environment: MetrikaEnvironment;
  commands: unknown[][];
  disabled: boolean[];
  injections: number;
  load: () => void;
};

function fakeMetrika(): FakeMetrika {
  const commands: unknown[][] = [];
  const disabled: boolean[] = [];
  let onload: () => void = () => {};
  let injections = 0;
  return {
    environment: {
      injectTag: (handlers) => { injections += 1; onload = handlers.onload; },
      setDisabled: (_counterId, value) => { disabled.push(value); },
      command: (...command) => { commands.push(command); },
    },
    commands,
    disabled,
    get injections() { return injections; },
    load: () => onload(),
  };
}

describe("Metrika consent manager", () => {
  it("does nothing before opt-in, validates public counter configuration, and keeps static HTML tag-free", () => {
    expect(metrikaCounterId()).toBeNull();
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

  it("does not initialize if consent is withdrawn while the tag is loading", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.observe("/", "");
    manager.enable();
    manager.disable();
    fake.load();
    expect(fake.commands).toEqual([]);
    expect(fake.disabled).toEqual([false, true]);
  });

  it("destructs once on withdrawal, sends no later sensitive hit, and re-enables cleanly", () => {
    const fake = fakeMetrika();
    const manager = createMetrikaManager(123, fake.environment);
    manager.observe("/", "");
    manager.enable();
    fake.load();
    manager.disable();
    manager.disable();
    manager.observe("/ticket", "");
    expect(fake.commands).toEqual([
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/"],
      [123, "destruct"],
    ]);

    manager.observe("/kemerovo", "?utm_medium=social");
    manager.enable();
    expect(fake.commands).toEqual([
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/"],
      [123, "destruct"],
      [123, "init", { defer: true, webvisor: false, clickmap: false, trackLinks: false, sendTitle: false }],
      [123, "hit", "/kemerovo?utm_medium=social"],
    ]);
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
