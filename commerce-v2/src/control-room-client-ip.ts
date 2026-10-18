import { isIP } from "node:net";

/** A single address only: never a forwarded list, CIDR, port or zone identifier. */
export function canonicalIp(value: string | undefined): string | undefined {
  if (!value || value !== value.trim() || value.includes("%") || !isIP(value)) return undefined;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return canonical;
}

export function controlRoomTrustedProxyIps(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map((part) => {
    const ip = canonicalIp(part.trim());
    if (!ip) throw new Error("CONTROL_ROOM_TRUSTED_PROXY_IPS_INVALID");
    return ip;
  });
}

/** Only nginx's replacement header is admitted, after verifying the transport peer. */
export function controlRoomClientIp(headers: Headers, peerAddress: string | undefined, trustedProxyIps: readonly string[]) {
  const peer = canonicalIp(peerAddress);
  if (!peer || !trustedProxyIps.some((ip) => canonicalIp(ip) === peer)) return undefined;
  return canonicalIp(headers.get("x-real-ip") ?? undefined);
}
