import { describe, expect, it } from "vitest";
import { loadCommerceOrigins, storefrontOrigin } from "../src/origins";

describe("storefront origins", () => {
  it("requires four explicit HTTPS origins in production", () => {
    expect(() => loadCommerceOrigins({ DEPLOY_ENV: "production" })).toThrow("PLATFORM_ORIGIN_REQUIRED");
    expect(() => loadCommerceOrigins({
      DEPLOY_ENV: "production",
      PLATFORM_ORIGIN: "https://flexperiment.ru/path",
      LAB_ORIGIN: "https://lab.flexperiment.ru",
      ADMIN_ORIGIN: "https://admin.flexperiment.ru",
      API_ORIGIN: "https://api.flexperiment.ru",
    })).toThrow("PLATFORM_ORIGIN_INVALID");
  });

  it("keeps customer storefronts separate from admin and API authority", () => {
    const origins = loadCommerceOrigins({
      DEPLOY_ENV: "production",
      PLATFORM_ORIGIN: "https://flexperiment.ru",
      LAB_ORIGIN: "https://lab.flexperiment.ru",
      ADMIN_ORIGIN: "https://admin.flexperiment.ru",
      API_ORIGIN: "https://api.flexperiment.ru",
    });
    expect(storefrontOrigin(origins, "COURSES")).toBe("https://flexperiment.ru");
    expect(storefrontOrigin(origins, "LAB")).toBe("https://lab.flexperiment.ru");
    expect(origins.admin).toBe("https://admin.flexperiment.ru");
    expect(origins.api).toBe("https://api.flexperiment.ru");
  });
});
