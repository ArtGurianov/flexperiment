import { AdminApiError } from "./api";

/**
 * Every code currently returned by an admin command route is deliberately
 * classified. New backend codes must be added here rather than accidentally
 * inheriting an optimistic "any 4xx is safe" policy.
 *
 * `false` is conservative: retain/replay the original key after refreshing
 * authoritative state. The handful of `true` codes fail before a domain
 * command can begin and therefore permit a fresh key.
 */
export const ADMIN_COMMAND_ERROR_SAFETY = {
  ADMIN_AUTH_REQUIRED: true,
  ADMIN_REAUTH_REQUIRED: true,
  AGENT_NOT_FOUND: false,
  CAPACITY_BELOW_OCCUPANCY: true,
  CITY_HAS_OCCURRENCES: true,
  CITY_NOT_FOUND: true,
  CITY_SLUG_CONFLICT: true,
  CITY_SLUG_UNKNOWN: true,
  CONFIRMATION_REQUIRED: true,
  CONTRACTOR_STATUS_REVIEW: true,
  EMAIL_ATTENTION_ACKNOWLEDGEMENT_REASON_REQUIRED: true,
  EMAIL_ATTENTION_NOT_ACTIONABLE: true,
  EMAIL_OUTBOX_NOT_FOUND: true,
  IDEMPOTENCY_CONFLICT: false,
  IDEMPOTENCY_KEY_REQUIRED: true,
  INVALID_CREDENTIALS: true,
  INVALID_JSON: true,
  OCCURRENCE_NOT_ENDED: true,
  OCCURRENCE_NOT_FOUND: true,
  OCCURRENCE_REVISION_CONFLICT: true,
  OCCURRENCE_SALES_MUST_BE_CLOSED: true,
  OCCURRENCE_STATE_TRANSITION_FORBIDDEN: true,
  OCCURRENCE_TERMINAL: true,
  OPERATIONAL_INCIDENT_NOT_OPEN: true,
  ORDER_NOT_FOUND: true,
  ORIGIN_FORBIDDEN: true,
  PAYMENT_ALREADY_SUCCEEDED: true,
  PAYMENT_NOT_REFUNDABLE: true,
  PROVIDER_RECONCILIATION_UNAVAILABLE: false,
  RATE_LIMITED: true,
  REFUND_AMOUNT_EXCEEDS_AVAILABLE: true,
  RESERVATION_NOT_ABANDONABLE: true,
  SETTLEMENT_BUSY: true,
  SETTLEMENT_EXCEEDS_AVAILABLE: true,
  SETTLEMENT_NOT_FOUND: true,
  SETTLEMENT_RECOVERY_AMOUNT_INVALID: true,
  SETTLEMENT_RECOVERY_EXCEEDS_REMAINING: true,
  SETTLEMENT_RECOVERY_NOT_PAID: true,
  SETTLEMENT_TRANSITION_FORBIDDEN: true,
  VALIDATION_ERROR: true,
  VENUE_ANNOUNCEMENT_TOO_LATE: true,
} as const;

export type AdminCommandErrorCode = keyof typeof ADMIN_COMMAND_ERROR_SAFETY;

export function safeToMintNewKey(error: AdminApiError): boolean {
  if (error.status === 401 || error.status === 403 || error.status === 429) return true;
  return ADMIN_COMMAND_ERROR_SAFETY[error.code as AdminCommandErrorCode] === true;
}

export const shouldRefreshAuthoritativeState = (error: AdminApiError) =>
  !safeToMintNewKey(error) || error.code === "IDEMPOTENCY_CONFLICT";
