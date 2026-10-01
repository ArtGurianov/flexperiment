import { afterEach, describe, expect, it, vi } from "vitest";
import { Media } from "../collections/Media";
import {
  publicImageContentSecurityPolicy,
  publicMediaBaseURL,
  publicMediaFileURL,
  publicMediaRemotePattern,
} from "../lib/public-media";

afterEach(() => vi.unstubAllEnvs());

describe("public editorial media", () => {
  it("generates every public derivative as WebP, including the 1200x630 OG image", () => {
    const upload = typeof Media.upload === "object" ? Media.upload : undefined;
    expect(upload?.formatOptions?.format).toBe("webp");
    expect(upload?.imageSizes).toMatchObject([
      { name: "card", width: 960, height: 640, formatOptions: { format: "webp" } },
      { name: "hero", width: 1920, height: 1080, formatOptions: { format: "webp" } },
      { name: "og", width: 1200, height: 630, formatOptions: { format: "webp" } },
    ]);
  });

  it("uses the public object host for URLs, CSP and the Next image allowlist", () => {
    vi.stubEnv("S3_PUBLIC_URL", "https://media.example.test/editorial");
    expect(publicMediaBaseURL().toString()).toBe("https://media.example.test/editorial/");
    expect(publicMediaFileURL({ prefix: "media/course one", filename: "hero image.webp" }))
      .toBe("https://media.example.test/editorial/media/course%20one/hero%20image.webp");
    expect(publicMediaRemotePattern()).toEqual({
      protocol: "https",
      hostname: "media.example.test",
      port: "",
      pathname: "/editorial/**",
      search: "",
    });
    expect(publicImageContentSecurityPolicy()).toContain("https://media.example.test");
  });

  it("rejects public media URLs that are not a credential-free HTTPS origin", () => {
    expect(() => publicMediaBaseURL("http://media.example.test")).toThrow("S3_PUBLIC_URL_INVALID");
    expect(() => publicMediaBaseURL("https://user:pass@media.example.test")).toThrow("S3_PUBLIC_URL_INVALID");
    expect(() => publicMediaBaseURL("https://media.example.test/?token=secret")).toThrow("S3_PUBLIC_URL_INVALID");
    expect(() => publicMediaFileURL({ prefix: "../private", filename: "secret.webp" }))
      .toThrow("PUBLIC_MEDIA_PATH_INVALID");
  });
});
