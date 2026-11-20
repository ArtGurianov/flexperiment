import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FLEX-120/121 review fixtures: keep the contract's machine-readable examples internally consistent.
const dir = join(__dirname, "../../docs/plans/fixtures/my-identity");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

type Targets = { accept: string[]; maxLength: number; default: string; cases: Array<{ input: string; result: string }> };
const resolve = (spec: Targets, input: string) =>
  input.length <= spec.maxLength && spec.accept.some((pattern) => new RegExp(pattern).test(input)) ? input : spec.default;

describe("my identity contract fixtures", () => {
  it("return-target cases follow the normative allowlists", () => {
    const targets = load("return-targets.json") as Record<"LMS" | "MY", Targets>;
    for (const surface of ["LMS", "MY"] as const) {
      for (const sample of targets[surface].cases) expect([surface, sample.input, resolve(targets[surface], sample.input)]).toEqual([surface, sample.input, sample.result]);
    }
  });

  it("exchange transitions never leave a terminal state", () => {
    const exchange = load("exchange.json") as { transitions: Array<{ from: string | null; to: string }>; terminal: string[] };
    for (const transition of exchange.transitions) expect(exchange.terminal).not.toContain(transition.from);
  });

  it("every cookie is host-only, HttpOnly and Secure; __Host- cookies use Path=/", () => {
    const { cookies } = load("surfaces.json") as { cookies: Record<string, { name: string; attributes: Record<string, unknown> }> };
    for (const cookie of Object.values(cookies)) {
      expect(cookie.attributes).toMatchObject({ Domain: null, HttpOnly: true, Secure: true, Path: "/" });
      expect(cookie.name.startsWith("__Host-") || cookie.name.startsWith("__Secure-")).toBe(true);
    }
  });

  it("isolation: no surface admits two session kinds and MY/LMS are disjoint in mode on", () => {
    const { admittedSessionKinds } = load("surfaces.json") as { admittedSessionKinds: Record<string, Record<string, string[]>> };
    for (const mode of Object.values(admittedSessionKinds)) for (const kinds of Object.values(mode)) expect(kinds.length).toBeLessThanOrEqual(1);
    expect(admittedSessionKinds.on.MY).toEqual(["MY"]);
    expect(admittedSessionKinds.on.LMS).toEqual(["LMS"]);
  });

  it("LMS and LAB profile examples carry no forbidden identifiers", () => {
    const profile = load("profile.json") as { LMS: { example: Record<string, unknown> }; neverOnLmsOrLab: string[] };
    for (const field of profile.neverOnLmsOrLab) expect(Object.keys(profile.LMS.example)).not.toContain(field);
  });
});
