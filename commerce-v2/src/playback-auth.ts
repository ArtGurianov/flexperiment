import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const ISSUER = "flexperiment-commerce-v2";
const AUDIENCE = "kinescope-drm";
const DEFAULT_TTL_MS = 2 * 60_000;

type PlaybackTokenClaims = {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  sub: string;
  vid: string;
  iat: number;
  exp: number;
  jti: string;
};

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const signature = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest();

const assertSecret = (secret: string) => {
  if (Buffer.byteLength(secret) < 32) throw new Error("KINESCOPE_DRM_TOKEN_SECRET_TOO_SHORT");
};

export function issuePlaybackToken(
  secret: string,
  input: { customerId: string; videoId: string },
  now = new Date(),
  ttlMs = DEFAULT_TTL_MS,
) {
  assertSecret(secret);
  if (!input.customerId || !input.videoId || ttlMs < 30_000 || ttlMs > 10 * 60_000) {
    throw new Error("KINESCOPE_DRM_TOKEN_INPUT_INVALID");
  }
  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.floor((now.getTime() + ttlMs) / 1000);
  const claims: PlaybackTokenClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: input.customerId,
    vid: input.videoId,
    iat,
    exp,
    jti: randomUUID(),
  };
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return { token: `${unsigned}.${signature(secret, unsigned).toString("base64url")}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyPlaybackToken(secret: string, token: string, expectedVideoId: string, now = new Date()) {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("PLAYBACK_TOKEN_MALFORMED");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const unsigned = `${encodedHeader}.${encodedClaims}`;
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(secret, unsigned);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("PLAYBACK_TOKEN_SIGNATURE_INVALID");

  let header: { alg?: unknown; typ?: unknown };
  let claims: Partial<PlaybackTokenClaims>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as Partial<PlaybackTokenClaims>;
  } catch {
    throw new Error("PLAYBACK_TOKEN_MALFORMED");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error("PLAYBACK_TOKEN_ALGORITHM_INVALID");
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw new Error("PLAYBACK_TOKEN_CONTEXT_INVALID");
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.vid !== "string" || !claims.vid
    || typeof claims.iat !== "number" || typeof claims.exp !== "number" || typeof claims.jti !== "string" || !claims.jti) {
    throw new Error("PLAYBACK_TOKEN_CLAIMS_INVALID");
  }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.iat > nowSeconds + 30) throw new Error("PLAYBACK_TOKEN_NOT_YET_VALID");
  if (claims.exp <= nowSeconds) throw new Error("PLAYBACK_TOKEN_EXPIRED");
  if (claims.vid !== expectedVideoId) throw new Error("PLAYBACK_TOKEN_VIDEO_MISMATCH");
  return { customerId: claims.sub, videoId: claims.vid, expiresAt: new Date(claims.exp * 1000).toISOString(), tokenId: claims.jti };
}
