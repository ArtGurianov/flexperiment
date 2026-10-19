import { canonicalIp, controlRoomClientIp } from "./control-room-client-ip";

/** LAB nginx is a separate peer from Admin. Exact addresses only, never a Docker subnet. */
export function labGuestTrustedProxyIps(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map(part => {
    const address = canonicalIp(part.trim());
    if (!address) throw new Error("LAB_GUEST_TRUSTED_PROXY_IPS_INVALID");
    return address;
  });
}

// Same socket-peer + nginx replacement-header rule as Control Room login.
export const labGuestClientIp = controlRoomClientIp;
