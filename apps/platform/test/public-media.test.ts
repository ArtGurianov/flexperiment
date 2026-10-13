import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publicImageContentSecurityPolicy,
  publicMediaBaseURL,
  publicMediaFileURL,
  publicMediaRemotePattern,
} from "../lib/public-media";

afterEach(() => vi.unstubAllEnvs());

describe("public editorial media", () => {
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
