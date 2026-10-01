import { afterEach, describe, expect, it, vi } from "vitest";
import { adminOrigin, apiOrigin, labOrigin, platformOrigin } from "../lib/origins";

afterEach(() => vi.unstubAllEnvs());

describe("platform origin authority", () => {
  it("reads each public authority from its explicit variable", () => {
    vi.stubEnv("PLATFORM_ORIGIN", "https://flexperiment.test");
    vi.stubEnv("LAB_ORIGIN", "https://lab.flexperiment.test");
    vi.stubEnv("ADMIN_ORIGIN", "https://admin.flexperiment.test");
    vi.stubEnv("API_ORIGIN", "https://api.flexperiment.test");
    expect({ platform: platformOrigin(), lab: labOrigin(), admin: adminOrigin(), api: apiOrigin() }).toEqual({
      platform: "https://flexperiment.test",
      lab: "https://lab.flexperiment.test",
      admin: "https://admin.flexperiment.test",
      api: "https://api.flexperiment.test",
    });
  });

  it("rejects a URL with path authority", () => {
    vi.stubEnv("PLATFORM_ORIGIN", "https://flexperiment.test/courses");
    expect(() => platformOrigin()).toThrow("PLATFORM_ORIGIN_INVALID");
  });
});
