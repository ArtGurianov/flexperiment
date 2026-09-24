import { isIP } from "node:net";

/**
 * What a provider said about delivering one message, reduced to the parts that
 * explain a delivery and nothing that identifies the recipient.
 *
 * Unisender's `delivery_info` also carries the recipient's IP, user agent,
 * device and location for opens and clicks. None of that is read. What is kept:
 *
 *   delivery_status        Unisender's own classification (`ok_sent`,
 *                          `err_will_retry`, `err_mailbox_full`, ...).
 *   destination_response   what the receiving SMTP server answered, redacted:
 *                          addresses, URLs and long opaque tokens removed,
 *                          control characters flattened, length capped.
 *   sender_ip              the address WE sent from, when Unisender reports it.
 *   event_time             when the provider says it happened, which is not
 *                          when we received the callback.
 *
 * 2026-09-24: the cancellation and refund emails stayed `sent` for hours and
 * nothing we stored could say whether the receiver deferred them or they never
 * left the provider. The receiver's answer is the fact that decides that.
 */
export type DeliveryEvidence = {
  readonly deliveryStatus: string | null;
  readonly destinationResponse: string | null;
  readonly senderIp: string | null;
  readonly eventTime: string | null;
};

export const DESTINATION_RESPONSE_MAX_LENGTH = 300;

export const sanitizeDeliveryStatus = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(value) ? value : null;

/** Anything that could still be an address separator after the patterns below. */
const AT = String.raw`(?:@|%40|\(at\)|\[at\]|\{at\})`;

export const sanitizeDestinationResponse = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const redacted = value
    // Control, format (bidi overrides, zero-width) and line/paragraph separators.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    // A quoted local part may contain spaces: "john doe"@example.com.
    .replace(new RegExp(String.raw`<?"[^"]*"\s*${AT}\s*[^\s<>@"]+>?`, "gi"), "<address>")
    .replace(new RegExp(String.raw`<?[^\s<>@"]+\s*${AT}\s*[^\s<>@"]+>?`, "gi"), "<address>")
    // Whatever is left of a separator, alone, is still not stored.
    .replace(new RegExp(AT, "gi"), "<address>")
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "<token>")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return null;
  // By code point, so a cut never leaves half a surrogate pair.
  const characters = Array.from(redacted);
  return characters.length > DESTINATION_RESPONSE_MAX_LENGTH ? `${characters.slice(0, DESTINATION_RESPONSE_MAX_LENGTH - 1).join("")}…` : redacted;
};

export const sanitizeSenderIp = (value: unknown): string | null =>
  typeof value === "string" && isIP(value) !== 0 ? value : null;

/** Unisender's `YYYY-MM-DD hh:mm:ss` UTC, stored as ISO. */
export const sanitizeProviderEventTime = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,6})?Z?$/.exec(value);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3] ?? ""}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
};

export const deliveryEvidence = (input: { deliveryStatus?: unknown; destinationResponse?: unknown; senderIp?: unknown; eventTime?: unknown }): DeliveryEvidence => ({
  deliveryStatus: sanitizeDeliveryStatus(input.deliveryStatus),
  destinationResponse: sanitizeDestinationResponse(input.destinationResponse),
  senderIp: sanitizeSenderIp(input.senderIp),
  eventTime: sanitizeProviderEventTime(input.eventTime),
});

/** The webhook's `event_data`: only the named `delivery_info` fields, never the rest of it. */
export const webhookDeliveryEvidence = (data: Record<string, unknown>): DeliveryEvidence => {
  const info = data.delivery_info && typeof data.delivery_info === "object" && !Array.isArray(data.delivery_info)
    ? data.delivery_info as Record<string, unknown>
    : {};
  return deliveryEvidence({ deliveryStatus: info.delivery_status, destinationResponse: info.destination_response, senderIp: info.sender_ip, eventTime: data.event_time });
};
