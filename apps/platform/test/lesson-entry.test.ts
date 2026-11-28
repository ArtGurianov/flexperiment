import { afterEach, describe, expect, it, vi } from "vitest";
import { lessonEntry } from "../lib/lesson-entry";

const lesson = "/courses/example/lessons/second";
const sharedEnvironment = {
  MY_IDENTITY_MODE: "on",
  MY_SESSION_COOKIE_DOMAIN: "fixture.test",
  MY_ORIGIN: "https://my.fixture.test",
  PLATFORM_ORIGIN: "https://lms.fixture.test",
  LAB_ORIGIN: "https://lab.fixture.test",
  MY_CHECKOUT_MODE: undefined,
};
const configure = (changes: Partial<Record<keyof typeof sharedEnvironment, string | undefined>> = {}) => {
  for (const [name, value] of Object.entries({ ...sharedEnvironment, ...changes })) vi.stubEnv(name, value);
};

afterEach(() => vi.unstubAllEnvs());

describe("lesson entry", () => {
  it("keeps the selected lesson through valid shared sign-in", () => {
    configure();
    expect(lessonEntry(lesson).myLogin).toBe(`/auth/lms/start?next=${encodeURIComponent(lesson)}`);
  });

  it.each([
    { MY_IDENTITY_MODE: "off" },
    { MY_ORIGIN: undefined },
    { LAB_ORIGIN: undefined },
    { LAB_ORIGIN: "https://lab.other.test" },
    { MY_SESSION_COOKIE_DOMAIN: "https://fixture.test" },
  ])("renders the entry with shared sign-in disabled for %j", changes => {
    configure(changes);
    expect(lessonEntry(lesson)).toEqual({ myLogin: undefined, myCheckoutOrigin: undefined });
  });
});
