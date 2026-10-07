import { describe, expect, it } from "vitest";
import { issuePlaybackToken, playbackKeyringFromEnvironment, verifyPlaybackToken, type PlaybackKeyring } from "../src/playback-auth";

const secret: PlaybackKeyring = { currentKeyId: "k1", keys: { k1: "playback-secret-with-at-least-32-bytes" } };
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
    const [header, payload, signature] = grant.token.split(".");
    const tamperedSignature = `${signature?.startsWith("a") ? "b" : "a"}${signature?.slice(1)}`;
    expect(() => verifyPlaybackToken(secret, `${header}.${payload}.${tamperedSignature}`, "video", new Date("2026-10-01T04:01:00.000Z")))
      .toThrow("PLAYBACK_TOKEN_SIGNATURE_INVALID");
  });

  it("rotates: a token names its key, any key in the ring verifies its own, a dropped key verifies nothing", () => {
    const k1 = "first-playback-secret-with-32-bytes!";
    const k2 = "second-playback-secret-with-32-bytes";
    const before = issuePlaybackToken({ currentKeyId: "k1", keys: { k1 } }, { customerId: "customer", videoId: "video" }, issuedAt);
    // During the overlap both keys verify; new tokens are signed with k2.
    const overlap: PlaybackKeyring = { currentKeyId: "k2", keys: { k1, k2 } };
    const after = issuePlaybackToken(overlap, { customerId: "customer", videoId: "video" }, issuedAt);
    const at = new Date("2026-10-01T04:01:00.000Z");
    expect(JSON.parse(Buffer.from(after.token.split(".")[0]!, "base64url").toString()).kid).toBe("k2");
    expect(verifyPlaybackToken(overlap, before.token, "video", at).customerId).toBe("customer");
    expect(verifyPlaybackToken(overlap, after.token, "video", at).customerId).toBe("customer");
    // k1 dropped: its tokens are refused, by name, not by a signature guess.
    expect(() => verifyPlaybackToken({ currentKeyId: "k2", keys: { k2 } }, before.token, "video", at)).toThrow("PLAYBACK_TOKEN_KEY_UNKNOWN");
    // A token naming k2 but signed with k1 is a forgery.
    const [, payload, sig] = before.token.split(".");
    const relabelled = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "k2" })).toString("base64url")}.${payload}.${sig}`;
    expect(() => verifyPlaybackToken(overlap, relabelled, "video", at)).toThrow("PLAYBACK_TOKEN_SIGNATURE_INVALID");
  });

  it("reads the keyring from the service's secrets, and refuses an ambiguous or weak one", () => {
    const strong = "x".repeat(32);
    expect(playbackKeyringFromEnvironment({})).toBeUndefined();
    expect(playbackKeyringFromEnvironment({ KINESCOPE_DRM_TOKEN_SECRET: strong })).toEqual({ currentKeyId: "legacy", keys: { legacy: strong } });
    expect(playbackKeyringFromEnvironment({ KINESCOPE_DRM_TOKEN_KEYS: JSON.stringify({ "2026-10": strong }), KINESCOPE_DRM_TOKEN_CURRENT_KEY: "2026-10" }))
      .toEqual({ currentKeyId: "2026-10", keys: { "2026-10": strong } });
    for (const [env, code] of [
      [{ KINESCOPE_DRM_TOKEN_SECRET: strong, KINESCOPE_DRM_TOKEN_KEYS: JSON.stringify({ a: strong }), KINESCOPE_DRM_TOKEN_CURRENT_KEY: "a" }, "KINESCOPE_DRM_TOKEN_KEYS_AMBIGUOUS"],
      [{ KINESCOPE_DRM_TOKEN_SECRET: "short" }, "KINESCOPE_DRM_TOKEN_SECRET_TOO_SHORT"],
      [{ KINESCOPE_DRM_TOKEN_KEYS: JSON.stringify({ a: strong }), KINESCOPE_DRM_TOKEN_CURRENT_KEY: "b" }, "KINESCOPE_DRM_TOKEN_KEYRING_INVALID"],
      [{ KINESCOPE_DRM_TOKEN_KEYS: JSON.stringify({ a: strong, b: "short" }), KINESCOPE_DRM_TOKEN_CURRENT_KEY: "a" }, "KINESCOPE_DRM_TOKEN_SECRET_TOO_SHORT"],
      [{ KINESCOPE_DRM_TOKEN_KEYS: JSON.stringify({ "Bad Id": strong }), KINESCOPE_DRM_TOKEN_CURRENT_KEY: "Bad Id" }, "KINESCOPE_DRM_TOKEN_KEY_ID_INVALID"],
      [{ KINESCOPE_DRM_TOKEN_KEYS: "not json", KINESCOPE_DRM_TOKEN_CURRENT_KEY: "a" }, "KINESCOPE_DRM_TOKEN_KEYRING_INVALID"],
    ] as const) expect(() => playbackKeyringFromEnvironment(env), code).toThrow(code);
  });
});
