import { describe, expect, it } from "vitest";
import { issuePlaybackToken, verifyPlaybackToken } from "../src/playback-auth";

const secret = "playback-secret-with-at-least-32-bytes";
const issuedAt = new Date("2026-10-01T04:00:00.000Z");

describe("protected playback token", () => {
  it("binds a short-lived signed token to its customer and video", () => {
    const grant = issuePlaybackToken(secret, { customerId: "customer", videoId: "video" }, issuedAt);
    expect(grant.expiresAt).toBe("2026-10-01T04:02:00.000Z");
    expect(verifyPlaybackToken(secret, grant.token, "video", new Date("2026-10-01T04:01:59.000Z")))
      .toMatchObject({ customerId: "customer", videoId: "video", expiresAt: grant.expiresAt });
  });

  it("rejects expiry, cross-video replay, and signature tampering", () => {
    const grant = issuePlaybackToken(secret, { customerId: "customer", videoId: "video" }, issuedAt);
    expect(() => verifyPlaybackToken(secret, grant.token, "video", new Date(grant.expiresAt)))
      .toThrow("PLAYBACK_TOKEN_EXPIRED");
    expect(() => verifyPlaybackToken(secret, grant.token, "other-video", new Date("2026-10-01T04:01:00.000Z")))
      .toThrow("PLAYBACK_TOKEN_VIDEO_MISMATCH");
    expect(() => verifyPlaybackToken(secret, `${grant.token.slice(0, -1)}x`, "video", new Date("2026-10-01T04:01:00.000Z")))
      .toThrow("PLAYBACK_TOKEN_SIGNATURE_INVALID");
  });
});
