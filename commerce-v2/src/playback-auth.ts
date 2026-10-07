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

/**
 * The playback signing keys (ART-221). Tokens are signed with the current key and name it (`kid`); any
 * key in the ring verifies its own tokens, so a rotation is: add the new key, make it current, and drop
 * the old one once every token it signed has expired (ten minutes at most). Keys live only in the
 * commerce service's secrets; nothing else holds them.
 */
export type PlaybackKeyring = { readonly currentKeyId: string; readonly keys: Readonly<Record<string, string>> };

const KEY_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const assertKeyring = (keyring: PlaybackKeyring) => {
  const ids = Object.keys(keyring.keys);
  if (ids.length === 0 || !Object.hasOwn(keyring.keys, keyring.currentKeyId)) throw new Error("KINESCOPE_DRM_TOKEN_KEYRING_INVALID");
  for (const id of ids) {
    if (!KEY_ID.test(id)) throw new Error("KINESCOPE_DRM_TOKEN_KEY_ID_INVALID");
    if (Buffer.byteLength(keyring.keys[id]!) < 32) throw new Error("KINESCOPE_DRM_TOKEN_SECRET_TOO_SHORT");
  }
};

/**
 * From the environment: KINESCOPE_DRM_TOKEN_KEYS (JSON, key id → secret) with
 * KINESCOPE_DRM_TOKEN_CURRENT_KEY, or the single legacy KINESCOPE_DRM_TOKEN_SECRET (key id "legacy").
 * Both at once is refused: which key signs would be a guess. None is undefined: the caller decides
 * whether protected delivery can start without one.
 */
export function playbackKeyringFromEnvironment(env: Readonly<Record<string, string | undefined>>): PlaybackKeyring | undefined {
  const legacy = env.KINESCOPE_DRM_TOKEN_SECRET;
  const ring = env.KINESCOPE_DRM_TOKEN_KEYS;
  if (legacy && ring) throw new Error("KINESCOPE_DRM_TOKEN_KEYS_AMBIGUOUS");
  if (!legacy && !ring) return undefined;
  let keyring: PlaybackKeyring;
  if (legacy) keyring = { currentKeyId: "legacy", keys: { legacy } };
  else {
    let keys: unknown;
    try { keys = JSON.parse(ring!); } catch { throw new Error("KINESCOPE_DRM_TOKEN_KEYRING_INVALID"); }
    if (typeof keys !== "object" || keys === null || Array.isArray(keys) || Object.values(keys).some((v) => typeof v !== "string")) {
      throw new Error("KINESCOPE_DRM_TOKEN_KEYRING_INVALID");
    }
    keyring = { currentKeyId: env.KINESCOPE_DRM_TOKEN_CURRENT_KEY ?? "", keys: keys as Record<string, string> };
  }
  assertKeyring(keyring);
  return keyring;
}

export function issuePlaybackToken(
  keyring: PlaybackKeyring,
  input: { customerId: string; videoId: string },
  now = new Date(),
  ttlMs = DEFAULT_TTL_MS,
) {
  assertKeyring(keyring);
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
  const kid = keyring.currentKeyId;
  const unsigned = `${encode({ alg: "HS256", typ: "JWT", kid })}.${encode(claims)}`;
  return { token: `${unsigned}.${signature(keyring.keys[kid]!, unsigned).toString("base64url")}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyPlaybackToken(keyring: PlaybackKeyring, token: string, expectedVideoId: string, now = new Date()) {
  assertKeyring(keyring);
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("PLAYBACK_TOKEN_MALFORMED");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  let header: { alg?: unknown; typ?: unknown; kid?: unknown };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as typeof header;
  } catch {
    throw new Error("PLAYBACK_TOKEN_MALFORMED");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error("PLAYBACK_TOKEN_ALGORITHM_INVALID");
  // The key the token names, and only a key this ring holds: a retired key verifies nothing.
  if (typeof header.kid !== "string" || !Object.hasOwn(keyring.keys, header.kid)) throw new Error("PLAYBACK_TOKEN_KEY_UNKNOWN");
  const unsigned = `${encodedHeader}.${encodedClaims}`;
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(keyring.keys[header.kid]!, unsigned);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("PLAYBACK_TOKEN_SIGNATURE_INVALID");

  let claims: Partial<PlaybackTokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as Partial<PlaybackTokenClaims>;
  } catch {
    throw new Error("PLAYBACK_TOKEN_MALFORMED");
  }
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
