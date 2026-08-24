#!/usr/bin/env bash
set -euo pipefail

# FLEXPERIMENT production E2E certification v2.
# Operator-run with real money. It keeps resume identifiers/idempotency keys,
# never prints payment/ticket capabilities, and never retries a new payment or
# refund after an ambiguous provider boundary.

ADMIN="${ADMIN:-https://admin.flexperiment.ru}"
API="${API:-https://api.flexperiment.ru}"
ADMIN_ORIGIN="${ADMIN_ORIGIN:-https://admin.flexperiment.ru}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://flexperiment.ru}"
EXPECTED_SOURCE_COMMIT="${EXPECTED_SOURCE_COMMIT:-}"
EXPECTED_MIGRATION="${EXPECTED_MIGRATION:-0028_customer_participant_ticketing.sql}"
EXPECTED_LEGAL_VERSION="${EXPECTED_LEGAL_VERSION:-2026-08-23.2}"
CITY_SLUG="kemerovo"
EMAIL_TIMEOUT_SECONDS="${EMAIL_TIMEOUT_SECONDS:-900}"
PAYMENT_TIMEOUT_SECONDS="${PAYMENT_TIMEOUT_SECONDS:-900}"
REFUND_TIMEOUT_SECONDS="${REFUND_TIMEOUT_SECONDS:-900}"

usage() {
  cat <<'EOF'
Usage:
  ./certification.sh
  ./certification.sh --resume .certification-state/production-e2e-<run-id>.json
  ./certification.sh --cleanup .certification-state/production-e2e-<run-id>.json
EOF
}

MODE=run; STATE_FILE=""
if [[ "${1:-}" == "--resume" || "${1:-}" == "--cleanup" ]]; then
  MODE="${1#--}"; STATE_FILE="${2:-}"; [[ -n "$STATE_FILE" ]] || { usage >&2; exit 2; }
elif [[ $# -ne 0 ]]; then usage >&2; exit 2; fi

RUN_TMP="$(mktemp -d)"; chmod 700 "$RUN_TMP"
COOKIE_JAR="$RUN_TMP/admin.cookies"; HTTP_BODY="$RUN_TMP/http.json"; CHECKOUT_BODY="$RUN_TMP/checkout.json"
touch "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_BODY"; chmod 600 "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_BODY"
on_exit() {
  local code=$?
  rm -rf "$RUN_TMP"
  if [[ "$code" -ne 0 && -n "${OCCURRENCE_ID:-}" && "${PHASE:-}" != "CLEANED" ]]; then
    echo "CERTIFICATION OCCURRENCE MAY STILL BE OPEN FOR SALES: $OCCURRENCE_ID" >&2
    echo "Resume: ./certification.sh --resume $STATE_FILE" >&2
    echo "Emergency sales-close/cleanup: ./certification.sh --cleanup $STATE_FILE" >&2
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "ERROR: $*" >&2; [[ -n "${STATE_FILE:-}" ]] && echo "Resume state retained: $STATE_FILE" >&2; exit 1; }
incomplete() { echo "INCOMPLETE: $*" >&2; [[ -n "${STATE_FILE:-}" ]] && echo "Resume state retained: $STATE_FILE" >&2; exit 2; }
new_key() { uuidgen | tr '[:upper:]' '[:lower:]'; }
request() { local output="$1"; shift; HTTP_CODE="$(curl -sS -o "$output" -w '%{http_code}' "$@")"; }
require_http() { [[ "$HTTP_CODE" == "$1" ]] || fail "$2 expected HTTP $1, got $HTTP_CODE"; }
require_2xx() { [[ "$HTTP_CODE" =~ ^2 ]] || fail "$1 returned HTTP $HTTP_CODE"; }
json() { jq -er "$1" "$2"; }

STATE_KEYS=(RUN_ID PHASE EXPECTED_SOURCE_COMMIT CITY_ID OCCURRENCE_ID OCCURRENCE_REVISION QUOTE_ID CHECKOUT_REQUEST_SHA256 STATUS_ID PAYMENT_URL_OPENED_AT ORDER_ID BOOKING_ID PAYMENT_ID TICKET_ID REFUND_OBLIGATION_ID REFUND_ID INITIAL_AVAILABILITY PAID_AVAILABILITY POST_CANCEL_AVAILABILITY CREATE_OCCURRENCE_KEY PUBLISH_KEY OPEN_SALES_KEY CHECKOUT_KEY CANCEL_BOOKING_KEY CLOSE_SALES_KEY HIDE_KEY PENDING_ADMIN_METHOD PENDING_ADMIN_PATH PENDING_ADMIN_KEY PENDING_ADMIN_BODY STARTED_AT)
STATE_PHASES=(NEW OCCURRENCE_CREATED OCCURRENCE_PUBLISHED OCCURRENCE_OPEN QUOTE_READY CHECKOUT_SUBMITTING CHECKOUT_CREATED ORDER_IDENTIFIED PAYMENT_PROVEN TICKET_EMAIL_DELIVERED BOOKING_CANCELLED BOOKING_CANCELLED_EMAIL_DELIVERED REFUND_SUCCEEDED REFUND_EMAIL_DELIVERED CLEANED)
save_state() {
  local tmp="$STATE_FILE.tmp" key
  local args=()
  for key in "${STATE_KEYS[@]}"; do args+=(--arg "$key" "${!key:-}"); done
  umask 077
  jq -n "${args[@]}" '$ARGS.named | with_entries(select(.value != ""))' > "$tmp"
  mv "$tmp" "$STATE_FILE"; chmod 600 "$STATE_FILE"
}
load_state() {
  [[ -f "$STATE_FILE" ]] || fail "resume state does not exist: $STATE_FILE"
  [[ "$(stat -f '%Lp' "$STATE_FILE")" == "600" ]] || fail "resume state must have mode 0600"
  local allowed phases key value
  allowed="$(printf '%s\n' "${STATE_KEYS[@]}" | jq -R . | jq -sc .)"
  phases="$(printf '%s\n' "${STATE_PHASES[@]}" | jq -R . | jq -sc .)"
  jq -e --argjson allowed "$allowed" --argjson phases "$phases" '
    type == "object"
    and ([keys[] | select(. as $key | $allowed | index($key) | not)] | length == 0)
    and all(.[]; type == "string")
    and (.RUN_ID | type == "string" and length > 0)
    and (.EXPECTED_SOURCE_COMMIT | type == "string" and length > 0)
    and (.PHASE as $phase | $phases | index($phase) != null)
  ' "$STATE_FILE" >/dev/null || fail "resume state is not a valid allowlisted JSON object"
  while IFS=$'\t' read -r key value; do printf -v "$key" '%s' "$value"; done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' "$STATE_FILE")
}
set_phase() { PHASE="$1"; save_state; }
ensure_key() { local name="$1"; [[ -n "${!name:-}" ]] || printf -v "$name" '%s' "$(new_key)"; save_state; }

if [[ "$MODE" == run ]]; then
  [[ -n "$EXPECTED_SOURCE_COMMIT" ]] || fail "EXPECTED_SOURCE_COMMIT=<exact deployed SOURCE_COMMIT> is required for a fresh run"
  RUN_ID="production-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
  STATE_FILE="$PWD/.certification-state/$RUN_ID.json"
  mkdir -p "${STATE_FILE%/*}"; chmod 700 "${STATE_FILE%/*}"
  PHASE=NEW; STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; save_state
else
  load_state
fi

echo "FLEXPERIMENT production E2E certification v2"
echo "run_id=$RUN_ID"
read -rsp "Admin password: " ADMIN_PASSWORD </dev/tty; echo
request "$HTTP_BODY" -c "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -H 'Content-Type: application/json' -X POST "$ADMIN/v1/admin/login" --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')"
unset ADMIN_PASSWORD; require_http 200 "Admin login"
grep -q $'\t' "$COOKIE_JAR" || fail "Admin login returned no session cookie"

admin_get() { request "$HTTP_BODY" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" "$ADMIN/v1/admin/$1"; require_2xx "Admin GET /$1"; }
admin_mutate() {
  local method="$1" path="$2" key="$3" body="$4"
  PENDING_ADMIN_METHOD="$method"; PENDING_ADMIN_PATH="$path"; PENDING_ADMIN_KEY="$key"; PENDING_ADMIN_BODY="$body"; save_state
  request "$HTTP_BODY" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -X "$method" "$ADMIN/v1/admin/$path" --data "$body"
  require_2xx "Admin $method /$path"
  PENDING_ADMIN_METHOD=""; PENDING_ADMIN_PATH=""; PENDING_ADMIN_KEY=""; PENDING_ADMIN_BODY=""; save_state
}
public_get() { request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/$1"; }

# A prior interrupted Admin request is replayed verbatim before any new work.
# Its canonical body/key are safe state fields (no customer PII or capability).
if [[ -n "${PENDING_ADMIN_METHOD:-}" ]]; then
  echo "Replaying interrupted Admin command: $PENDING_ADMIN_METHOD /$PENDING_ADMIN_PATH"
  request "$HTTP_BODY" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -H 'Content-Type: application/json' -H "Idempotency-Key: $PENDING_ADMIN_KEY" -X "$PENDING_ADMIN_METHOD" "$ADMIN/v1/admin/$PENDING_ADMIN_PATH" --data "$PENDING_ADMIN_BODY"
  require_2xx "Replay interrupted Admin command"
  PENDING_ADMIN_METHOD=""; PENDING_ADMIN_PATH=""; PENDING_ADMIN_KEY=""; PENDING_ADMIN_BODY=""; save_state
fi

if [[ "$MODE" == cleanup ]]; then
  [[ -n "${OCCURRENCE_ID:-}" ]] || fail "state has no occurrence ID"
else
  request "$HTTP_BODY" "$API/healthz"; require_http 200 "Commerce health"; jq -e '.ok == true' "$HTTP_BODY" >/dev/null || fail "Commerce health is not OK"
  request "$HTTP_BODY" "$API/readyz"; require_http 200 "Commerce readiness"; jq -e '.ok == true' "$HTTP_BODY" >/dev/null || fail "Commerce readiness is not OK"
  admin_get system/evidence
  jq -e --arg commit "$EXPECTED_SOURCE_COMMIT" --arg migration "$EXPECTED_MIGRATION" --arg legal "$EXPECTED_LEGAL_VERSION" '.source_commit_evidence == "machine" and .migration_evidence == "machine" and .source_commit == $commit and .migration_head.version == $migration and .active_legal_release.version == $legal' "$HTTP_BODY" >/dev/null || fail "system evidence does not match expected source commit, migration head, or legal release"
  jq -e '.active_legal_release.manifest.documents.PUBLIC_OFFER.sha256 == "cf4797bc09fe5f59e751a614b56aa31998631b0b219864c364a2e5474272265b" and .active_legal_release.manifest.documents.PRIVACY_POLICY.sha256 == "97ac1add022f8ca4f870647c7abc525cf9b32a6edcc12fcd2484339769497864" and .active_legal_release.manifest.documents.PD_CONSENT.sha256 == "313390b685e82e73d190f5300295df1d5b83905787b3d92531d5b3c8d126d30f" and .active_legal_release.manifest.documents.CHECKOUT_DISCLOSURE.sha256 == "81c46b287ee9f5d79d07923d11e53ccbe01c11c38ef5dbc5057af3b4833bd48d"' "$HTTP_BODY" >/dev/null || fail "active legal document hashes do not match frozen release"
fi

refresh_occurrence() { admin_get "occurrences/$OCCURRENCE_ID"; cp "$HTTP_BODY" "$RUN_TMP/occurrence.json"; }
patch_occurrence() {
  local label="$1" patch="$2" key_name="$3" revision body
  ensure_key "$key_name"; refresh_occurrence; revision="$(json '.admin_revision' "$RUN_TMP/occurrence.json")"
  body="$(jq -nc --argjson revision "$revision" --arg reason "Production E2E certification $RUN_ID" --argjson patch "$patch" '$patch + {expected_revision:$revision,reason:$reason}')"
  admin_mutate PATCH "occurrences/$OCCURRENCE_ID" "${!key_name}" "$body"
  OCCURRENCE_REVISION="$(json '.admin_revision' "$HTTP_BODY")"; save_state; echo "$label: OK"
}
close_and_hide() {
  refresh_occurrence
  [[ "$(json '.sales_status' "$RUN_TMP/occurrence.json")" == CLOSED ]] || patch_occurrence "Close sales" '{sales_status:"CLOSED"}' CLOSE_SALES_KEY
  refresh_occurrence
  [[ "$(json '.visibility' "$RUN_TMP/occurrence.json")" == HIDDEN ]] || patch_occurrence "Hide occurrence" '{visibility:"HIDDEN"}' HIDE_KEY
  refresh_occurrence; jq -e '.sales_status == "CLOSED" and .visibility == "HIDDEN"' "$RUN_TMP/occurrence.json" >/dev/null || fail "cleanup did not leave occurrence HIDDEN+CLOSED"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 404 "Hidden occurrence public detail"
  public_get tour; require_http 200 "Public tour after cleanup"; jq -e --arg id "$OCCURRENCE_ID" '[.cities[]?.id] | index($id) == null' "$HTTP_BODY" >/dev/null || fail "hidden certification occurrence remains in public tour"
  set_phase CLEANED
}

if [[ "$MODE" == cleanup ]]; then close_and_hide; echo "CLEANUP COMPLETE occurrence=$OCCURRENCE_ID state=$STATE_FILE"; exit 0; fi

if [[ "$PHASE" == NEW ]]; then
  admin_get cities; CITY_ID="$(jq -er '.cities[] | select(.slug == "kemerovo") | .id' "$HTTP_BODY" | head -n1)" || fail "canonical Kemerovo city is absent; do not create a duplicate city"
  read -rp "STARTS_AT (RFC3339 offset): " STARTS_AT </dev/tty
  read -rp "ENDS_AT (RFC3339 offset): " ENDS_AT </dev/tty
  read -rp "Venue disclosure text: " VENUE_DISCLOSURE_TEXT </dev/tty
  read -rp "VENUE_ANNOUNCE_BY (RFC3339 offset): " VENUE_ANNOUNCE_BY </dev/tty
  python3 - "$STARTS_AT" "$ENDS_AT" "$VENUE_ANNOUNCE_BY" <<'PY'
from datetime import datetime
import sys
def parse(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None: raise ValueError('timezone offset is required')
    return value
try: start, end, announce = map(parse, sys.argv[1:])
except ValueError as error: raise SystemExit(f'ERROR: invalid RFC3339 timestamp: {error}')
if end <= start: raise SystemExit('ERROR: ENDS_AT must be after STARTS_AT')
if announce >= start: raise SystemExit('ERROR: VENUE_ANNOUNCE_BY must be before STARTS_AT')
PY
  ensure_key CREATE_OCCURRENCE_KEY
  create_body="$(jq -nc --arg city "$CITY_ID" --arg title "FLEXPERIMENT — Кемерово — production E2E $RUN_ID" --arg start "$STARTS_AT" --arg end "$ENDS_AT" --arg disclosure "$VENUE_DISCLOSURE_TEXT" --arg announce "$VENUE_ANNOUNCE_BY" '{city_id:$city,title:$title,starts_at:$start,ends_at:$end,timezone:"Asia/Novokuznetsk",price_kopecks:100,capacity:1,venue_status:"TO_BE_ANNOUNCED",venue_disclosure_text:$disclosure,venue_announce_by:$announce,reason:"Production E2E certification"}')"
  admin_mutate POST occurrences "$CREATE_OCCURRENCE_KEY" "$create_body"; OCCURRENCE_ID="$(json '.id' "$HTTP_BODY")"; OCCURRENCE_REVISION="$(json '.admin_revision' "$HTTP_BODY")"; set_phase OCCURRENCE_CREATED
  jq -e '.visibility == "HIDDEN" and .sales_status == "CLOSED" and .price_kopecks == 100 and .capacity == 1' "$HTTP_BODY" >/dev/null || fail "created occurrence is not HIDDEN+CLOSED 1 RUB capacity 1"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 404 "Hidden occurrence public detail"
fi
if [[ "$PHASE" == OCCURRENCE_CREATED ]]; then
  refresh_occurrence
  if [[ "$(json '.visibility' "$RUN_TMP/occurrence.json")" != PUBLISHED ]]; then patch_occurrence "Publish occurrence" '{visibility:"PUBLISHED"}' PUBLISH_KEY; fi
  set_phase OCCURRENCE_PUBLISHED
fi
if [[ "$PHASE" == OCCURRENCE_PUBLISHED ]]; then
  refresh_occurrence
  if [[ "$(json '.sales_status' "$RUN_TMP/occurrence.json")" != OPEN ]]; then patch_occurrence "Open sales" '{sales_status:"OPEN"}' OPEN_SALES_KEY; fi
  public_get "occurrences/$OCCURRENCE_ID"; require_http 200 "Published occurrence public detail"; jq -e '.visibility == "PUBLISHED" and .sales_status == "OPEN" and .availability == 1 and .price_kopecks == 100 and .capacity == 1' "$HTTP_BODY" >/dev/null || fail "published occurrence is not sellable with availability 1"
  INITIAL_AVAILABILITY=1; save_state
  set_phase OCCURRENCE_OPEN
fi

if [[ "$PHASE" == OCCURRENCE_OPEN ]]; then
  request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' -X POST "$API/v1/public/checkout-context" --data "$(jq -nc --arg occurrence "$OCCURRENCE_ID" '{occurrence_id:$occurrence}')"; require_http 200 "Checkout context"; QUOTE_ID="$(json '.quote_id' "$HTTP_BODY")"; set_phase QUOTE_READY
fi

replay_checkout() {
  local checkout_request checkout_request_sha
  read -rp "Real test email: " CUSTOMER_EMAIL </dev/tty; read -rp "Customer name: " CUSTOMER_NAME </dev/tty; read -rp "Customer date of birth (YYYY-MM-DD): " CUSTOMER_DOB </dev/tty
  checkout_request="$(jq -nc --arg quote "$QUOTE_ID" --arg name "$CUSTOMER_NAME" --arg email "$CUSTOMER_EMAIL" --arg dob "$CUSTOMER_DOB" '{quote_id:$quote,customer_name:$name,customer_email:$email,customer_adult_confirmed:true,participant:{self:true,date_of_birth:$dob},offer_accepted:true,pd_consent_accepted:true}')"
  checkout_request_sha="$(printf '%s' "$checkout_request" | shasum -a 256 | awk '{print $1}')"
  if [[ -n "${CHECKOUT_REQUEST_SHA256:-}" ]]; then
    [[ "$checkout_request_sha" == "$CHECKOUT_REQUEST_SHA256" ]] || fail "re-entered checkout data does not match the persisted pre-dispatch request hash; do not create another checkout"
  else
    CHECKOUT_REQUEST_SHA256="$checkout_request_sha"; save_state
  fi
  request "$CHECKOUT_BODY" -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' -H "Idempotency-Key: $CHECKOUT_KEY" -X POST "$API/v1/public/checkouts" --data "$checkout_request"; require_2xx "Replay existing checkout"
  unset CUSTOMER_EMAIL CUSTOMER_NAME CUSTOMER_DOB checkout_request checkout_request_sha
}
if [[ "$PHASE" == QUOTE_READY ]]; then
  ensure_key CHECKOUT_KEY
  # The only stored pre-dispatch facts are quote ID and idempotency key. The
  # operator re-enters PII on resume; permanent idempotency rejects any body
  # that is not byte/canonically identical to the original checkout request.
  set_phase CHECKOUT_SUBMITTING
fi
if [[ "$PHASE" == CHECKOUT_SUBMITTING ]]; then
  replay_checkout
  STATUS_ID="$(json '.status_id' "$CHECKOUT_BODY")"; set_phase CHECKOUT_CREATED
fi
if [[ "$PHASE" == CHECKOUT_CREATED && -z "${PAYMENT_URL_OPENED_AT:-}" ]]; then
  # A POST replay is safe here: same stored quote/key and canonical request.
  # It recovers a link after a crash before `open` without a second payment.
  replay_checkout
  replayed_status="$(json '.status_id' "$CHECKOUT_BODY")"
  [[ "$replayed_status" == "$STATUS_ID" ]] || fail "checkout replay returned a different status ID"
  PAYMENT_URL="$(jq -r '.payment_url // empty' "$CHECKOUT_BODY")"; [[ -n "$PAYMENT_URL" ]] || incomplete "existing checkout has no payment URL; do not create another checkout"
  echo "Opening existing real payment URL without printing it."; open "$PAYMENT_URL"; unset PAYMENT_URL
  PAYMENT_URL_OPENED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; save_state
fi

wait_checkout_paid() {
  local deadline=$(( $(date +%s) + PAYMENT_TIMEOUT_SECONDS )) status
  while (( $(date +%s) < deadline )); do
    public_get "checkout-status/$STATUS_ID"; require_http 200 "Checkout status"; status="$(json '.status' "$HTTP_BODY")"
    [[ "$status" == PAID ]] && return 0; [[ "$status" == FAILED ]] && fail "checkout reached FAILED; do not create another payment"; sleep 10
  done
  incomplete "payment did not reach PAID before timeout; reconcile existing payment only"
}
read_order_evidence() { admin_get "orders/$ORDER_ID/evidence"; cp "$HTTP_BODY" "$RUN_TMP/order-evidence.json"; }
find_order_from_status() {
  local matches
  admin_get orders
  matches="$(jq -cer --arg status "$STATUS_ID" '[.orders[] | select(.public_status_id == $status) | .id]' "$HTTP_BODY")"
  [[ "$(jq 'length' <<<"$matches")" == 1 ]] || incomplete "expected exactly one order for checkout status ID; do not create another checkout"
  ORDER_ID="$(jq -er '.[0]' <<<"$matches")"
  set_phase ORDER_IDENTIFIED
}
if [[ "$PHASE" == CHECKOUT_CREATED ]]; then read -rp "Complete the real 1 RUB Tochka payment, then press Enter: " _ </dev/tty; wait_checkout_paid; find_order_from_status; fi
if [[ "$PHASE" == ORDER_IDENTIFIED ]]; then
  read_order_evidence; PAYMENT_ID="$(json '.payment.id' "$RUN_TMP/order-evidence.json")"; BOOKING_ID="$(json '.booking.id' "$RUN_TMP/order-evidence.json")"; TICKET_ID="$(json '.ticket.id' "$RUN_TMP/order-evidence.json")"
  jq -e --arg payment "$PAYMENT_ID" '.payment.status == "PAID" and .payment.captured_amount_kopecks == 100 and .booking.status == "CONFIRMED" and .ticket.status == "VALID" and ([.tochka_webhook_events[]? | select(.provider == "TOCHKA" and .status == "APPLIED" and .entity_id == $payment)] | length) >= 1' "$RUN_TMP/order-evidence.json" >/dev/null || incomplete "PAID/ticket/signed Tochka webhook evidence is incomplete"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 200 "Public occurrence after payment"; jq -e '.availability == 0' "$HTTP_BODY" >/dev/null || fail "confirmed booking did not reserve exactly one seat"
  PAID_AVAILABILITY=0; save_state
  set_phase PAYMENT_PROVEN
fi

wait_email() {
  local type="$1" ref="$2" deadline=$(( $(date +%s) + EMAIL_TIMEOUT_SECONDS )) row status outbox
  while (( $(date +%s) < deadline )); do
    read_order_evidence
    row="$(jq -cer --arg type "$type" --arg ref "$ref" '[.email_outbox[] | select(.type == $type and .payload_ref == $ref)] | if length == 1 then .[0] else empty end' "$RUN_TMP/order-evidence.json")" || incomplete "expected exactly one $type outbox for existing evidence ref"
    status="$(jq -r '.status' <<<"$row")"
    if [[ "$status" == DELIVERED ]]; then
      outbox="$(jq -r '.id' <<<"$row")"; jq -e --arg id "$outbox" '[.email_provider_events[]? | select(.outbox_id == $id and .status == "DELIVERED")] | length >= 1' "$RUN_TMP/order-evidence.json" >/dev/null || incomplete "$type says DELIVERED without durable provider-event evidence"
      jq -e '.job_id | type == "string" and length > 0' <<<"$row" >/dev/null || incomplete "$type delivered without job_id"; printf '%s' "$row"; return 0
    fi
    [[ "$status" =~ ^(BOUNCED|FAILED|SEND_UNKNOWN)$ ]] && fail "$type email entered terminal non-delivery status $status"; sleep 10
  done
  incomplete "$type email delivery timed out; investigate existing outbox without resend"
}
if [[ "$PHASE" == PAYMENT_PROVEN ]]; then TICKET_EMAIL_JSON="$(wait_email TICKET "$TICKET_ID")"; set_phase TICKET_EMAIL_DELIVERED; fi
if [[ "$PHASE" == TICKET_EMAIL_DELIVERED ]]; then
  read -rp "Verify mailbox, ticket link, participant and occurrence. Type yes to continue: " verified </dev/tty; [[ "$verified" == yes ]] || incomplete "human ticket verification was not confirmed"
  ensure_key CANCEL_BOOKING_KEY; cancel_body="$(jq -nc --arg booking "$BOOKING_ID" '{reason:"Production E2E certification customer cancellation",confirmation_text:("CANCEL " + $booking),withheld_expense_amount_kopecks:0}')"
  admin_mutate POST "bookings/$BOOKING_ID/cancel-customer-initiated" "$CANCEL_BOOKING_KEY" "$cancel_body"; set_phase BOOKING_CANCELLED
fi
if [[ "$PHASE" == BOOKING_CANCELLED ]]; then
  read_order_evidence; jq -e '.booking.status == "CANCELLED" and .ticket.status == "VOID"' "$RUN_TMP/order-evidence.json" >/dev/null || fail "customer cancellation did not cancel booking and void ticket"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 200 "Public occurrence after cancellation"; jq -e '.availability == 1' "$HTTP_BODY" >/dev/null || fail "customer cancellation did not release exactly one seat"
  POST_CANCEL_AVAILABILITY=1; save_state
  BOOKING_CANCELLED_EMAIL_JSON="$(wait_email BOOKING_CANCELLED "$BOOKING_ID")"; set_phase BOOKING_CANCELLED_EMAIL_DELIVERED
fi

wait_refund() {
  local deadline=$(( $(date +%s) + REFUND_TIMEOUT_SECONDS )) status
  while (( $(date +%s) < deadline )); do
    read_order_evidence; REFUND_OBLIGATION_ID="$(jq -er '.refund_obligation.id' "$RUN_TMP/order-evidence.json")" || { sleep 10; continue; }
    jq -e '.refund_obligation.initial_source == "CUSTOMER_CANCELLATION_PARTIAL" and .refund_obligation.target_refunded_amount_kopecks == 100' "$RUN_TMP/order-evidence.json" >/dev/null || fail "refund obligation is not expected full customer-cancellation obligation"
    REFUND_ID="$(jq -er --arg payment "$PAYMENT_ID" --arg obligation "$REFUND_OBLIGATION_ID" '[.refunds[] | select(.payment_id == $payment and .source == "REFUND_OBLIGATION" and .refund_obligation_id == $obligation)] | if length == 1 then .[0].id else empty end' "$RUN_TMP/order-evidence.json")" || { sleep 10; continue; }
    status="$(jq -r --arg refund "$REFUND_ID" '.refunds[] | select(.id == $refund) | .status' "$RUN_TMP/order-evidence.json")"
    if [[ "$status" == SUCCEEDED ]]; then
      jq -e --arg refund "$REFUND_ID" '.refunds[] | select(.id == $refund) | .amount_kopecks == 100 and (.provider_reference | type == "string" and length > 0)' "$RUN_TMP/order-evidence.json" >/dev/null || incomplete "succeeded refund lacks the expected amount or provider reference"
      return 0
    fi
    [[ "$status" =~ ^(FAILED|REVIEW_REQUIRED)$ ]] && fail "existing refund $REFUND_ID reached $status; do not create another refund"; sleep 10
  done
  incomplete "refund did not reach SUCCEEDED before timeout; reconcile existing refund only"
}
if [[ "$PHASE" == BOOKING_CANCELLED_EMAIL_DELIVERED ]]; then wait_refund; set_phase REFUND_SUCCEEDED; fi
if [[ "$PHASE" == REFUND_SUCCEEDED ]]; then REFUND_EMAIL_JSON="$(wait_email REFUND_SUCCEEDED "$REFUND_ID")"; set_phase REFUND_EMAIL_DELIVERED; fi
if [[ "$PHASE" == REFUND_EMAIL_DELIVERED ]]; then
  close_and_hide; read_order_evidence; COMPLETED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ARTIFACT_DIR="$PWD/artifacts/certification"; mkdir -p "$ARTIFACT_DIR"; chmod 700 "$ARTIFACT_DIR"; MANIFEST="$ARTIFACT_DIR/flexperiment-production-e2e-${RUN_ID}.json"
  admin_get system/evidence; cp "$HTTP_BODY" "$RUN_TMP/system-evidence.json"
  jq -n --slurpfile system "$RUN_TMP/system-evidence.json" --slurpfile evidence "$RUN_TMP/order-evidence.json" --arg run "$RUN_ID" --arg started "$STARTED_AT" --arg completed "$COMPLETED_AT" --arg occurrence "$OCCURRENCE_ID" --arg status "$STATUS_ID" --arg booking "$BOOKING_ID" --arg ticket "$TICKET_ID" --arg obligation "$REFUND_OBLIGATION_ID" --arg refund "$REFUND_ID" --argjson initial_availability "$INITIAL_AVAILABILITY" --argjson paid_availability "$PAID_AVAILABILITY" --argjson post_cancel_availability "$POST_CANCEL_AVAILABILITY" '
    def outbox($type; $ref): $evidence[0].email_outbox[] | select(.type == $type and .payload_ref == $ref);
    def email_evidence($type; $ref):
      (outbox($type; $ref)) as $outbox |
      {outbox:$outbox,provider_events:[$evidence[0].email_provider_events[] | select(.outbox_id == $outbox.id)]};
    {result:"PASS",run_id:$run,environment:"production",started_at:$started,completed_at:$completed,build:$system[0],occurrence:{id:$occurrence,final_sales_status:"CLOSED",final_visibility:"HIDDEN",public_cleanup_verified:true,availability:{before_payment:$initial_availability,after_payment:$paid_availability,after_customer_cancellation:$post_cancel_availability}},order:{id:$evidence[0].order.id,status_id:$status,currency:$evidence[0].order.currency},payment:$evidence[0].payment,tochka_webhook_events:$evidence[0].tochka_webhook_events,booking:{id:$booking,before_cancellation:"CONFIRMED",after_cancellation:$evidence[0].booking.status},ticket:{id:$ticket,before_cancellation:"VALID",after_cancellation:$evidence[0].ticket.status,human_verified:true},emails:{ticket:email_evidence("TICKET"; $ticket),booking_cancelled:email_evidence("BOOKING_CANCELLED"; $booking),refund_succeeded:email_evidence("REFUND_SUCCEEDED"; $refund)},refund_obligation:($evidence[0].refund_obligation|select(.id==$obligation)),refund:($evidence[0].refunds[]|select(.id==$refund))}' > "$MANIFEST"
  chmod 600 "$MANIFEST"; echo "PASS"; echo "Evidence manifest: $MANIFEST"; echo "Resume state retained for audit: $STATE_FILE"
fi
