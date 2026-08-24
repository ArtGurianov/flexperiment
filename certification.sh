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
EXPECTED_LEGAL_RELEASE_ID="${EXPECTED_LEGAL_RELEASE_ID:-}"
EXPECTED_PUBLIC_OFFER_SHA256="${EXPECTED_PUBLIC_OFFER_SHA256:-cf4797bc09fe5f59e751a614b56aa31998631b0b219864c364a2e5474272265b}"
EXPECTED_PRIVACY_POLICY_SHA256="${EXPECTED_PRIVACY_POLICY_SHA256:-97ac1add022f8ca4f870647c7abc525cf9b32a6edcc12fcd2484339769497864}"
EXPECTED_PD_CONSENT_SHA256="${EXPECTED_PD_CONSENT_SHA256:-313390b685e82e73d190f5300295df1d5b83905787b3d92531d5b3c8d126d30f}"
EXPECTED_CHECKOUT_DISCLOSURE_SHA256="${EXPECTED_CHECKOUT_DISCLOSURE_SHA256:-81c46b287ee9f5d79d07923d11e53ccbe01c11c38ef5dbc5057af3b4833bd48d}"
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/certification-recovery.sh
source "$SCRIPT_DIR/scripts/certification-recovery.sh"

RUN_TMP="$(mktemp -d)"; chmod 700 "$RUN_TMP"
COOKIE_JAR="$RUN_TMP/admin.cookies"; HTTP_BODY="$RUN_TMP/http.json"; CHECKOUT_BODY="$RUN_TMP/checkout.json"
touch "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_BODY"; chmod 600 "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_BODY"
on_exit() {
  local code=$?
  # Best effort only: session revocation must neither conceal nor alter the
  # certification outcome. It runs before the ephemeral cookie jar is removed.
  if [[ -s "${COOKIE_JAR:-/nonexistent}" ]]; then
    curl -sS --max-time 2 -o /dev/null -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -X POST "$ADMIN/v1/admin/logout" >/dev/null 2>&1 || true
  fi
  rm -rf "$RUN_TMP"
  if [[ "$code" -ne 0 && -n "${OCCURRENCE_ID:-}" ]]; then
    if [[ -n "${SALES_CLEANUP_STARTED_AT:-}" || -n "${SALES_CLEANED_AT:-}" ]]; then
      echo "CERTIFICATION FAILED AFTER CLEANUP STARTED: verify occurrence remains CLOSED+HIDDEN and finish --cleanup before any resume: $OCCURRENCE_ID" >&2
    else
      echo "CERTIFICATION OCCURRENCE MAY STILL BE OPEN FOR SALES: $OCCURRENCE_ID" >&2
      echo "Emergency sales-close/cleanup: ./certification.sh --cleanup $STATE_FILE" >&2
    fi
    echo "Resume: ./certification.sh --resume $STATE_FILE" >&2
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "ERROR: $*" >&2; [[ -n "${STATE_FILE:-}" ]] && echo "Resume state retained: $STATE_FILE" >&2; exit 1; }
incomplete() { echo "INCOMPLETE: $*" >&2; [[ -n "${STATE_FILE:-}" ]] && echo "Resume state retained: $STATE_FILE" >&2; exit 2; }
new_key() { uuidgen | tr '[:upper:]' '[:lower:]'; }
request() { local output="$1"; shift; HTTP_CODE="$(curl -sS -o "$output" -w '%{http_code}' "$@")"; }
request_stdin() {
  local output="$1" body="$2"
  shift 2
  HTTP_CODE="$(printf '%s' "$body" | curl -sS -o "$output" -w '%{http_code}' "$@" --data-binary @-)"
}
require_http() { [[ "$HTTP_CODE" == "$1" ]] || fail "$2 expected HTTP $1, got $HTTP_CODE"; }
require_2xx() { [[ "$HTTP_CODE" =~ ^2 ]] || fail "$1 returned HTTP $HTTP_CODE"; }
json() { jq -er "$1" "$2"; }

STATE_KEYS=(RUN_ID PHASE EXPECTED_SOURCE_COMMIT EXPECTED_MIGRATION EXPECTED_LEGAL_RELEASE_ID EXPECTED_LEGAL_VERSION EXPECTED_PUBLIC_OFFER_SHA256 EXPECTED_PRIVACY_POLICY_SHA256 EXPECTED_PD_CONSENT_SHA256 EXPECTED_CHECKOUT_DISCLOSURE_SHA256 CITY_ID OCCURRENCE_ID OCCURRENCE_REVISION CREATE_OCCURRENCE_BODY QUOTE_ID CHECKOUT_REQUEST_SHA256 STATUS_ID PAYMENT_URL_OPENED_AT ORDER_ID BOOKING_ID PAYMENT_ID TICKET_ID REFUND_OBLIGATION_ID REFUND_ID INITIAL_AVAILABILITY PAID_AVAILABILITY POST_CANCEL_AVAILABILITY SALES_CLEANUP_STARTED_AT SALES_CLEANED_AT HUMAN_TICKET_VERIFIED_AT COMPLETED_AT MANIFEST_WRITTEN_AT CREATE_OCCURRENCE_KEY PUBLISH_KEY OPEN_SALES_KEY CHECKOUT_KEY CANCEL_BOOKING_KEY CLOSE_SALES_KEY HIDE_KEY PENDING_OPERATION PENDING_EXPECTED_REVISION STARTED_AT)
STATE_PHASES=(NEW OCCURRENCE_CREATED OCCURRENCE_PUBLISHED OCCURRENCE_OPEN QUOTE_READY CHECKOUT_SUBMITTING CHECKOUT_CREATED ORDER_IDENTIFIED PAYMENT_PROVEN TICKET_EMAIL_DELIVERED BOOKING_CANCELLED BOOKING_CANCELLED_EMAIL_DELIVERED REFUND_SUCCEEDED REFUND_EMAIL_DELIVERED OCCURRENCE_CLEANED COMPLETE)
PENDING_OPERATIONS=(CREATE_OCCURRENCE PUBLISH_OCCURRENCE OPEN_SALES CANCEL_BOOKING)
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
  [[ "$(python3 - "$STATE_FILE" <<'PY'
import os
import stat
import sys
print(f"{stat.S_IMODE(os.stat(sys.argv[1]).st_mode):03o}")
PY
)" == "600" ]] || fail "resume state must have mode 0600"
  # Resume state, not inherited process environment, is the sole authority for
  # every persisted command/identity/checkpoint fact.
  certification_clear_state_values "${STATE_KEYS[@]}"
  local allowed phases operations key value
  allowed="$(printf '%s\n' "${STATE_KEYS[@]}" | jq -R . | jq -sc .)"
  phases="$(printf '%s\n' "${STATE_PHASES[@]}" | jq -R . | jq -sc .)"
  operations="$(printf '%s\n' "${PENDING_OPERATIONS[@]}" | jq -R . | jq -sc .)"
  jq -e --argjson allowed "$allowed" --argjson phases "$phases" --argjson operations "$operations" '
    type == "object"
    and ([keys[] | select(. as $key | $allowed | index($key) | not)] | length == 0)
    and all(.[]; type == "string")
    and (.RUN_ID | type == "string" and length > 0)
    and (.EXPECTED_SOURCE_COMMIT | type == "string" and length > 0)
    and (.PHASE as $phase | $phases | index($phase) != null)
    and ((.PENDING_OPERATION // "") as $operation | $operation == "" or ($operations | index($operation) != null))
  ' "$STATE_FILE" >/dev/null || fail "resume state is not a valid allowlisted JSON object"
  while IFS=$'\t' read -r key value; do printf -v "$key" '%s' "$value"; done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' "$STATE_FILE")
  validate_pending_operation_state
}
validate_pending_operation_state() {
  [[ -z "${PENDING_OPERATION:-}" ]] && return 0
  certification_pending_operation_phase_valid "$PENDING_OPERATION" "$PHASE" || fail "pending operation is not valid for the persisted certification phase"
  case "$PENDING_OPERATION:$PHASE" in
    CREATE_OCCURRENCE:NEW)
      [[ -n "${CREATE_OCCURRENCE_BODY:-}" && -n "${CREATE_OCCURRENCE_KEY:-}" ]] || fail "pending occurrence creation lacks its safe command facts"
      ;;
    PUBLISH_OCCURRENCE:OCCURRENCE_CREATED)
      [[ -n "${OCCURRENCE_ID:-}" && -n "${PUBLISH_KEY:-}" && -n "${PENDING_EXPECTED_REVISION:-}" ]] || fail "pending publication lacks occurrence/revision facts"
      ;;
    OPEN_SALES:OCCURRENCE_PUBLISHED)
      [[ -n "${OCCURRENCE_ID:-}" && -n "${OPEN_SALES_KEY:-}" && -n "${PENDING_EXPECTED_REVISION:-}" ]] || fail "pending sales opening lacks occurrence/revision facts"
      ;;
    CANCEL_BOOKING:TICKET_EMAIL_DELIVERED)
      [[ -n "${ORDER_ID:-}" && -n "${STATUS_ID:-}" && -n "${PAYMENT_ID:-}" && -n "${BOOKING_ID:-}" && -n "${TICKET_ID:-}" && -n "${HUMAN_TICKET_VERIFIED_AT:-}" && -n "${CANCEL_BOOKING_KEY:-}" ]] || fail "pending customer cancellation lacks certified order/booking/human-verification facts"
      ;;
    *) fail "pending operation lacks required state facts" ;;
  esac
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
  # Backward-compatible monotonic upgrade for a state written by the prior
  # script revision: completed cleanup is necessarily started cleanup.
  if [[ -n "${SALES_CLEANED_AT:-}" && -z "${SALES_CLEANUP_STARTED_AT:-}" ]]; then
    SALES_CLEANUP_STARTED_AT="$SALES_CLEANED_AT"; save_state
  fi
fi

echo "FLEXPERIMENT production E2E certification v2"
echo "run_id=$RUN_ID"
read -rsp "Admin password: " ADMIN_PASSWORD </dev/tty; echo
LOGIN_BODY="$(printf '%s' "$ADMIN_PASSWORD" | python3 -c 'import json, sys; print(json.dumps({"password": sys.stdin.read()}))')"
unset ADMIN_PASSWORD
request_stdin "$HTTP_BODY" "$LOGIN_BODY" -c "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -H 'Content-Type: application/json' -X POST "$ADMIN/v1/admin/login"
unset LOGIN_BODY; require_http 200 "Admin login"
grep -q $'\t' "$COOKIE_JAR" || fail "Admin login returned no session cookie"

admin_get() { request "$HTTP_BODY" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" "$ADMIN/v1/admin/$1"; require_2xx "Admin GET /$1"; }
admin_request() {
  local method="$1" path="$2" key="$3" body="$4" label="$5"
  request "$HTTP_BODY" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -X "$method" "$ADMIN/v1/admin/$path" --data "$body"
  require_2xx "$label"
}
public_get() { request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/$1"; }

assert_system_evidence() {
  admin_get system/evidence
  if [[ -z "${EXPECTED_LEGAL_RELEASE_ID:-}" ]]; then
    EXPECTED_LEGAL_RELEASE_ID="$(json '.active_legal_release.id' "$HTTP_BODY")"
    save_state
  fi
  jq -e \
    --arg commit "$EXPECTED_SOURCE_COMMIT" \
    --arg migration "$EXPECTED_MIGRATION" \
    --arg release "$EXPECTED_LEGAL_RELEASE_ID" \
    --arg legal "$EXPECTED_LEGAL_VERSION" \
    --arg offer "$EXPECTED_PUBLIC_OFFER_SHA256" \
    --arg privacy "$EXPECTED_PRIVACY_POLICY_SHA256" \
    --arg consent "$EXPECTED_PD_CONSENT_SHA256" \
    --arg disclosure "$EXPECTED_CHECKOUT_DISCLOSURE_SHA256" '
      .source_commit_evidence == "machine"
      and .migration_evidence == "machine"
      and .source_commit == $commit
      and .migration_head.version == $migration
      and .active_legal_release.id == $release
      and .active_legal_release.version == $legal
      and .active_legal_release.manifest.documents.PUBLIC_OFFER.sha256 == $offer
      and .active_legal_release.manifest.documents.PRIVACY_POLICY.sha256 == $privacy
      and .active_legal_release.manifest.documents.PD_CONSENT.sha256 == $consent
      and .active_legal_release.manifest.documents.CHECKOUT_DISCLOSURE.sha256 == $disclosure
    ' "$HTTP_BODY" >/dev/null || incomplete "system evidence no longer matches the frozen production certification baseline"
  cp "$HTTP_BODY" "$RUN_TMP/system-evidence.json"
}

if [[ "$MODE" == cleanup ]]; then
  [[ -n "${OCCURRENCE_ID:-}" ]] || fail "state has no occurrence ID"
else
  request "$HTTP_BODY" "$API/healthz"; require_http 200 "Commerce health"; jq -e '.ok == true' "$HTTP_BODY" >/dev/null || fail "Commerce health is not OK"
  request "$HTTP_BODY" "$API/readyz"; require_http 200 "Commerce readiness"; jq -e '.ok == true' "$HTTP_BODY" >/dev/null || fail "Commerce readiness is not OK"
  assert_system_evidence
fi

refresh_occurrence() { admin_get "occurrences/$OCCURRENCE_ID"; cp "$HTTP_BODY" "$RUN_TMP/occurrence.json"; }
assert_certification_occurrence_identity() {
  refresh_occurrence
  certification_occurrence_identity_valid "$RUN_TMP/occurrence.json" "$CITY_SLUG" "FLEXPERIMENT — Кемерово — production E2E $RUN_ID" || fail "persisted occurrence is not this run's canonical 1 RUB Kemerovo certification occurrence"
}
assert_certification_order_identity() {
  local evidence_file="${1:-$RUN_TMP/order-evidence.json}"
  certification_order_identity_valid "$evidence_file" "$ORDER_ID" "$STATUS_ID" "$OCCURRENCE_ID" "$PAYMENT_ID" "$BOOKING_ID" "$TICKET_ID" || fail "order/payment/booking/ticket evidence is not bound to this certification run"
}
assert_pending_operation_identity() {
  [[ -n "${PENDING_OPERATION:-}" ]] || return 0
  validate_pending_operation_state
  case "$PENDING_OPERATION" in
    CREATE_OCCURRENCE)
      admin_get cities
      local canonical_city_id
      canonical_city_id="$(jq -er '.cities[] | select(.slug == "kemerovo") | .id' "$HTTP_BODY" | head -n1)" || fail "canonical Kemerovo city is absent"
      jq -e --arg city "$canonical_city_id" --arg title "FLEXPERIMENT — Кемерово — production E2E $RUN_ID" '
        .city_id == $city
        and .title == $title
        and .timezone == "Asia/Novokuznetsk"
        and .price_kopecks == 100
        and .capacity == 1
        and .venue_status == "TO_BE_ANNOUNCED"
        and (.venue_disclosure_text | type == "string" and length > 0)
        and (.venue_announce_by | type == "string" and length > 0)
        and (.starts_at | type == "string" and length > 0)
        and (.ends_at | type == "string" and length > 0)
        and .reason == "Production E2E certification"
      ' <<<"$CREATE_OCCURRENCE_BODY" >/dev/null || fail "pending occurrence creation body is not the canonical certification command"
      ;;
    PUBLISH_OCCURRENCE|OPEN_SALES)
      assert_certification_occurrence_identity
      ;;
    CANCEL_BOOKING)
      assert_certification_occurrence_identity
      admin_get "orders/$ORDER_ID/evidence"
      cp "$HTTP_BODY" "$RUN_TMP/pending-order-evidence.json"
      assert_certification_order_identity "$RUN_TMP/pending-order-evidence.json"
      ;;
  esac
}
assert_occurrence_availability() {
  local expected="$1" context="$2"
  refresh_occurrence
  jq -e --argjson expected "$expected" '.availability == $expected' "$RUN_TMP/occurrence.json" >/dev/null || fail "$context did not produce occurrence availability $expected"
}
occurrence_patch_body() {
  local patch="$1" revision="$2"
  jq -nc --argjson revision "$revision" --arg reason "Production E2E certification $RUN_ID" --argjson patch "$patch" '$patch + {expected_revision:$revision,reason:$reason}'
}
clear_pending_operation() {
  PENDING_OPERATION=""; PENDING_EXPECTED_REVISION=""; save_state
}
replay_pending_operation() {
  local body key
  [[ -n "${PENDING_OPERATION:-}" ]] || return 0
  assert_pending_operation_identity
  case "$PENDING_OPERATION" in
    CREATE_OCCURRENCE)
      if [[ -n "${OCCURRENCE_ID:-}" ]]; then
        clear_pending_operation; CREATE_OCCURRENCE_BODY=""; save_state; return 0
      fi
      echo "Replaying interrupted occurrence creation."
      admin_request POST occurrences "$CREATE_OCCURRENCE_KEY" "$CREATE_OCCURRENCE_BODY" "Replay occurrence creation"
      OCCURRENCE_ID="$(json '.id' "$HTTP_BODY")"; OCCURRENCE_REVISION="$(json '.admin_revision' "$HTTP_BODY")"; PHASE=OCCURRENCE_CREATED
      clear_pending_operation; CREATE_OCCURRENCE_BODY=""; save_state
      ;;
    PUBLISH_OCCURRENCE|OPEN_SALES)
      if [[ "$PENDING_OPERATION" == PUBLISH_OCCURRENCE ]]; then key="$PUBLISH_KEY"; body="$(occurrence_patch_body '{"visibility":"PUBLISHED"}' "$PENDING_EXPECTED_REVISION")"; else key="$OPEN_SALES_KEY"; body="$(occurrence_patch_body '{"sales_status":"OPEN"}' "$PENDING_EXPECTED_REVISION")"; fi
      echo "Replaying interrupted occurrence transition: $PENDING_OPERATION"
      admin_request PATCH "occurrences/$OCCURRENCE_ID" "$key" "$body" "Replay $PENDING_OPERATION"
      OCCURRENCE_REVISION="$(json '.admin_revision' "$HTTP_BODY")"; clear_pending_operation
      ;;
    CANCEL_BOOKING)
      body="$(jq -nc --arg booking "$BOOKING_ID" '{reason:"Production E2E certification customer cancellation",confirmation_text:("CANCEL " + $booking),withheld_expense_amount_kopecks:0}')"
      echo "Replaying interrupted customer cancellation."
      admin_request POST "bookings/$BOOKING_ID/cancel-customer-initiated" "$CANCEL_BOOKING_KEY" "$body" "Replay customer cancellation"
      clear_pending_operation
      ;;
    *) fail "unsupported pending operation" ;;
  esac
}
start_occurrence_transition() {
  local operation="$1" patch="$2" key_name="$3" label="$4" revision body
  ensure_key "$key_name"; refresh_occurrence; revision="$(json '.admin_revision' "$RUN_TMP/occurrence.json")"
  PENDING_OPERATION="$operation"; PENDING_EXPECTED_REVISION="$revision"; save_state
  replay_pending_operation
  echo "$label: OK"
}
cleanup_occurrence_patch() {
  local label="$1" patch="$2" key_name="$3" revision body
  ensure_key "$key_name"; refresh_occurrence; revision="$(json '.admin_revision' "$RUN_TMP/occurrence.json")"
  body="$(occurrence_patch_body "$patch" "$revision")"
  # Cleanup has no generic pending replay. If its response is lost, the next
  # cleanup invocation refreshes state and observes the desired value.
  admin_request PATCH "occurrences/$OCCURRENCE_ID" "${!key_name}" "$body" "$label"
  OCCURRENCE_REVISION="$(json '.admin_revision' "$HTTP_BODY")"; save_state; echo "$label: OK"
}
close_and_hide() {
  # Persist the irreversible cleanup intent before the first destructive
  # mutation. A crash at any later point can never make catalog reopening a
  # valid recovery action.
  assert_certification_occurrence_identity
  SALES_CLEANUP_STARTED_AT="${SALES_CLEANUP_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; save_state
  refresh_occurrence
  [[ "$(json '.sales_status' "$RUN_TMP/occurrence.json")" == CLOSED ]] || cleanup_occurrence_patch "Close sales" '{"sales_status":"CLOSED"}' CLOSE_SALES_KEY
  refresh_occurrence
  [[ "$(json '.visibility' "$RUN_TMP/occurrence.json")" == HIDDEN ]] || cleanup_occurrence_patch "Hide occurrence" '{"visibility":"HIDDEN"}' HIDE_KEY
  assert_cleanup_evidence
  SALES_CLEANED_AT="${SALES_CLEANED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; save_state
}
assert_cleanup_evidence() {
  refresh_occurrence; jq -e '.sales_status == "CLOSED" and .visibility == "HIDDEN"' "$RUN_TMP/occurrence.json" >/dev/null || fail "cleanup did not leave occurrence HIDDEN+CLOSED"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 404 "Hidden occurrence public detail"
  public_get tour; require_http 200 "Public tour after cleanup"; jq -e --arg id "$OCCURRENCE_ID" '[.cities[]?.id] | index($id) == null' "$HTTP_BODY" >/dev/null || fail "hidden certification occurrence remains in public tour"
}

if [[ "$MODE" == cleanup ]]; then
  # Emergency cleanup never replays a pending OPEN/create/cancellation command.
  close_and_hide
  echo "CLEANUP COMPLETE occurrence=$OCCURRENCE_ID state=$STATE_FILE phase=$PHASE"
  exit 0
fi

# Only a verified current deployment may recover an interrupted allowlisted
# Admin operation. This is deliberately after assert_system_evidence().
case "$(certification_recovery_action "$MODE" "$PHASE" "${PENDING_OPERATION:-}" VERIFIED "${SALES_CLEANUP_STARTED_AT:-${SALES_CLEANED_AT:-}}")" in
  REPLAY_PENDING) replay_pending_operation ;;
  CONTINUE|CLEAN_OCCURRENCE|WRITE_MANIFEST|REPORT_COMPLETE) ;;
  CLEANUP_REQUIRED) incomplete "cleanup was started before the current phase; finish --cleanup before any normal resume can change catalog state" ;;
  *) fail "certification recovery planner rejected the current resume state" ;;
esac

if [[ "$PHASE" == NEW ]]; then
  if [[ -z "${CREATE_OCCURRENCE_BODY:-}" ]]; then
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
    CREATE_OCCURRENCE_BODY="$(jq -nc --arg city "$CITY_ID" --arg title "FLEXPERIMENT — Кемерово — production E2E $RUN_ID" --arg start "$STARTS_AT" --arg end "$ENDS_AT" --arg disclosure "$VENUE_DISCLOSURE_TEXT" --arg announce "$VENUE_ANNOUNCE_BY" '{city_id:$city,title:$title,starts_at:$start,ends_at:$end,timezone:"Asia/Novokuznetsk",price_kopecks:100,capacity:1,venue_status:"TO_BE_ANNOUNCED",venue_disclosure_text:$disclosure,venue_announce_by:$announce,reason:"Production E2E certification"}')"
    save_state
  fi
  ensure_key CREATE_OCCURRENCE_KEY
  PENDING_OPERATION=CREATE_OCCURRENCE; save_state
  replay_pending_operation
  jq -e '.visibility == "HIDDEN" and .sales_status == "CLOSED" and .price_kopecks == 100 and .capacity == 1' "$HTTP_BODY" >/dev/null || fail "created occurrence is not HIDDEN+CLOSED 1 RUB capacity 1"
  public_get "occurrences/$OCCURRENCE_ID"; require_http 404 "Hidden occurrence public detail"
fi
if [[ "$PHASE" == OCCURRENCE_CREATED ]]; then
  refresh_occurrence
  if [[ "$(json '.visibility' "$RUN_TMP/occurrence.json")" != PUBLISHED ]]; then start_occurrence_transition PUBLISH_OCCURRENCE '{"visibility":"PUBLISHED"}' PUBLISH_KEY "Publish occurrence"; fi
  set_phase OCCURRENCE_PUBLISHED
fi
if [[ "$PHASE" == OCCURRENCE_PUBLISHED ]]; then
  refresh_occurrence
  if [[ "$(json '.sales_status' "$RUN_TMP/occurrence.json")" != OPEN ]]; then start_occurrence_transition OPEN_SALES '{"sales_status":"OPEN"}' OPEN_SALES_KEY "Open sales"; fi
  public_get "occurrences/$OCCURRENCE_ID"; require_http 200 "Published occurrence public detail"; jq -e '.visibility == "PUBLISHED" and .sales_status == "OPEN" and .availability == 1 and .price_kopecks == 100 and .capacity == 1' "$HTTP_BODY" >/dev/null || fail "published occurrence is not sellable with availability 1"
  INITIAL_AVAILABILITY=1; save_state
  set_phase OCCURRENCE_OPEN
fi

if [[ "$PHASE" == OCCURRENCE_OPEN ]]; then
  assert_system_evidence
  request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' -X POST "$API/v1/public/checkout-context" --data "$(jq -nc --arg occurrence "$OCCURRENCE_ID" '{occurrence_id:$occurrence}')"; require_http 200 "Checkout context"; QUOTE_ID="$(json '.quote_id' "$HTTP_BODY")"; set_phase QUOTE_READY
fi

replay_checkout() {
  local checkout_request checkout_request_sha
  read -rp "Real test email: " CUSTOMER_EMAIL </dev/tty; read -rp "Customer name: " CUSTOMER_NAME </dev/tty; read -rp "Customer date of birth (YYYY-MM-DD): " CUSTOMER_DOB </dev/tty
  checkout_request="$(printf '%s\n%s\n%s' "$CUSTOMER_NAME" "$CUSTOMER_EMAIL" "$CUSTOMER_DOB" | python3 -c '
import json
import sys
name, email, dob = sys.stdin.read().splitlines()
print(json.dumps({"quote_id": sys.argv[1], "customer_name": name, "customer_email": email, "customer_adult_confirmed": True, "participant": {"self": True, "date_of_birth": dob}, "offer_accepted": True, "pd_consent_accepted": True}, ensure_ascii=False, separators=(",", ":")))
' "$QUOTE_ID")"
  checkout_request_sha="$(printf '%s' "$checkout_request" | shasum -a 256 | awk '{print $1}')"
  if [[ -n "${CHECKOUT_REQUEST_SHA256:-}" ]]; then
    [[ "$checkout_request_sha" == "$CHECKOUT_REQUEST_SHA256" ]] || fail "re-entered checkout data does not match the persisted pre-dispatch request hash; do not create another checkout"
  else
    CHECKOUT_REQUEST_SHA256="$checkout_request_sha"; save_state
  fi
  request_stdin "$CHECKOUT_BODY" "$checkout_request" -H "Origin: $PUBLIC_ORIGIN" -H 'Content-Type: application/json' -H "Idempotency-Key: $CHECKOUT_KEY" -X POST "$API/v1/public/checkouts"; require_2xx "Replay existing checkout"
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
  assert_system_evidence
  replay_checkout
  STATUS_ID="$(json '.status_id' "$CHECKOUT_BODY")"; set_phase CHECKOUT_CREATED
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
recover_existing_checkout() {
  # Before re-opening a durable checkout link, avoid asking for PII or opening
  # a provider page when the existing payment has already reached a terminal
  # result. A non-terminal link is recovered only by its same quote/key/body.
  public_get "checkout-status/$STATUS_ID"; require_http 200 "Existing checkout status"
  local existing_checkout_status replayed_status
  existing_checkout_status="$(json '.status' "$HTTP_BODY")"
  if [[ "$existing_checkout_status" == PAID ]]; then
    find_order_from_status
  elif [[ "$existing_checkout_status" == FAILED ]]; then
    fail "existing checkout reached FAILED; do not create another payment"
  else
    # A POST replay is safe here: same stored quote/key and canonical request.
    # This deliberately permits a later resume to reopen the same URL without
    # persisting or printing it; it never creates a second payment.
    replay_checkout
    replayed_status="$(json '.status_id' "$CHECKOUT_BODY")"
    [[ "$replayed_status" == "$STATUS_ID" ]] || fail "checkout replay returned a different status ID"
    PAYMENT_URL="$(jq -r '.payment_url // empty' "$CHECKOUT_BODY")"; [[ -n "$PAYMENT_URL" ]] || incomplete "existing checkout has no payment URL; do not create another checkout"
    echo "Opening existing real payment URL without printing it."; open "$PAYMENT_URL"; unset PAYMENT_URL
    PAYMENT_URL_OPENED_AT="${PAYMENT_URL_OPENED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; save_state
  fi
}
if [[ "$PHASE" == CHECKOUT_CREATED ]]; then recover_existing_checkout; fi
if [[ "$PHASE" == CHECKOUT_CREATED ]]; then read -rp "Complete the real 1 RUB Tochka payment, then press Enter: " _ </dev/tty; wait_checkout_paid; find_order_from_status; fi
if [[ "$PHASE" == ORDER_IDENTIFIED ]]; then
  read_order_evidence; PAYMENT_ID="$(json '.payment.id' "$RUN_TMP/order-evidence.json")"; BOOKING_ID="$(json '.booking.id' "$RUN_TMP/order-evidence.json")"; TICKET_ID="$(json '.ticket.id' "$RUN_TMP/order-evidence.json")"
  assert_certification_order_identity
  jq -e \
    --arg payment "$PAYMENT_ID" \
    --arg release "$EXPECTED_LEGAL_RELEASE_ID" \
    --arg offer "$EXPECTED_PUBLIC_OFFER_SHA256" \
    --arg privacy "$EXPECTED_PRIVACY_POLICY_SHA256" \
    --arg consent "$EXPECTED_PD_CONSENT_SHA256" \
    --arg disclosure "$EXPECTED_CHECKOUT_DISCLOSURE_SHA256" '
      .payment.status == "PAID"
      and .payment.captured_amount_kopecks == 100
      and .booking.status == "CONFIRMED"
      and .ticket.status == "VALID"
      and (.order.customer_adult_confirmed_at | type == "string" and length > 0)
      and .order.participant_is_customer == 1
      and .order.participant_is_minor == 0
      and (.order.participant_age_at_occurrence | type == "number" and . >= 18)
      and .order.participant_requires_adult_accompaniment == 0
      and .order.minor_legal_representative_confirmed_at == null
      and .order.under_14_accompaniment_confirmed_at == null
      and .order.checkout_legal_release_id == $release
      and .order.public_offer_sha256 == $offer
      and .order.privacy_policy_sha256 == $privacy
      and .order.pd_consent_sha256 == $consent
      and .order.checkout_disclosure_sha256 == $disclosure
      and ([.tochka_webhook_events[]? | select(.provider == "TOCHKA" and .status == "APPLIED" and .entity_id == $payment)] | length) >= 1
    ' "$RUN_TMP/order-evidence.json" >/dev/null || incomplete "PAID/ticket/signed Tochka webhook or frozen legal evidence is incomplete"
  assert_occurrence_availability 0 "confirmed booking"
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
assert_email_evidence() {
  local type="$1" ref="$2"
  certification_email_evidence_row "$RUN_TMP/order-evidence.json" "$type" "$ref" || fail "final $type email evidence is incomplete, contradictory, or not unique"
}
assert_final_email_evidence() {
  TICKET_FINAL_EMAIL_JSON="$(assert_email_evidence TICKET "$TICKET_ID")"
  BOOKING_CANCELLED_FINAL_EMAIL_JSON="$(assert_email_evidence BOOKING_CANCELLED "$BOOKING_ID")"
  REFUND_SUCCEEDED_FINAL_EMAIL_JSON="$(assert_email_evidence REFUND_SUCCEEDED "$REFUND_ID")"
}
if [[ "$PHASE" == PAYMENT_PROVEN ]]; then TICKET_EMAIL_JSON="$(wait_email TICKET "$TICKET_ID")"; set_phase TICKET_EMAIL_DELIVERED; fi
if [[ "$PHASE" == TICKET_EMAIL_DELIVERED ]]; then
  if [[ -z "${HUMAN_TICKET_VERIFIED_AT:-}" ]]; then
    read -rp "Verify mailbox, ticket link, participant and occurrence. Type yes to continue: " verified </dev/tty; [[ "$verified" == yes ]] || incomplete "human ticket verification was not confirmed"
    HUMAN_TICKET_VERIFIED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; save_state
  fi
  assert_system_evidence
  read_order_evidence; assert_certification_order_identity
  ensure_key CANCEL_BOOKING_KEY; PENDING_OPERATION=CANCEL_BOOKING; save_state
  replay_pending_operation; set_phase BOOKING_CANCELLED
fi
if [[ "$PHASE" == BOOKING_CANCELLED ]]; then
  read_order_evidence; jq -e '.booking.status == "CANCELLED" and .ticket.status == "VOID"' "$RUN_TMP/order-evidence.json" >/dev/null || fail "customer cancellation did not cancel booking and void ticket"
  assert_occurrence_availability 1 "customer cancellation"
  POST_CANCEL_AVAILABILITY=1; save_state
  BOOKING_CANCELLED_EMAIL_JSON="$(wait_email BOOKING_CANCELLED "$BOOKING_ID")"; set_phase BOOKING_CANCELLED_EMAIL_DELIVERED
fi

wait_refund() {
  local deadline=$(( $(date +%s) + REFUND_TIMEOUT_SECONDS )) matches match_count action succeeded_observed=0
  while (( $(date +%s) < deadline )); do
    read_order_evidence; REFUND_OBLIGATION_ID="$(jq -er '.refund_obligation.id' "$RUN_TMP/order-evidence.json")" || { sleep 10; continue; }
    jq -e '.refund_obligation.initial_source == "CUSTOMER_CANCELLATION_PARTIAL" and .refund_obligation.target_refunded_amount_kopecks == 100' "$RUN_TMP/order-evidence.json" >/dev/null || fail "refund obligation is not expected full customer-cancellation obligation"
    matches="$(jq -cer --arg payment "$PAYMENT_ID" --arg obligation "$REFUND_OBLIGATION_ID" '[.refunds[] | select(.payment_id == $payment and .source == "REFUND_OBLIGATION" and .refund_obligation_id == $obligation)]' "$RUN_TMP/order-evidence.json")"
    match_count="$(jq 'length' <<<"$matches")"
    [[ "$match_count" -le 1 ]] || fail "duplicate local REFUND_OBLIGATION refunds exist for this certification payment"
    [[ "$match_count" == 1 ]] || { sleep 10; continue; }
    REFUND_ID="$(jq -er '.[0].id' <<<"$matches")"
    action="$(certification_refund_poll_action "$RUN_TMP/order-evidence.json" "$PAYMENT_ID" "$REFUND_OBLIGATION_ID" "$REFUND_ID")" \
      || fail "existing refund $REFUND_ID has no readable status"
    case "$action" in
      CONVERGED) return 0 ;;
      WAIT_FOR_DERIVED)
        # A pre-fix deployment can expose provider success before its derived
        # payment/obligation facts. Continue read-only polling only.
        succeeded_observed=1; sleep 10; continue
        ;;
      TERMINAL:*) fail "existing refund $REFUND_ID reached ${action#TERMINAL:}; do not create another refund" ;;
      WAIT) sleep 10 ;;
      *) fail "existing refund $REFUND_ID produced invalid polling action: $action" ;;
    esac
  done
  (( succeeded_observed )) && incomplete "succeeded refund derived evidence did not converge before timeout; reconcile existing refund only"
  incomplete "refund did not reach SUCCEEDED before timeout; reconcile existing refund only"
}
assert_final_refund_evidence() {
  certification_refund_evidence_converged "$RUN_TMP/order-evidence.json" "$PAYMENT_ID" "$REFUND_OBLIGATION_ID" "$REFUND_ID" \
    || fail "final refund evidence is not exactly one fulfilled 100-kopek customer-cancellation obligation refund with REFUNDED payment"
}
assert_final_order_evidence() {
  assert_certification_order_identity
  jq -e \
    --arg payment "$PAYMENT_ID" \
    --arg release "$EXPECTED_LEGAL_RELEASE_ID" \
    --arg offer "$EXPECTED_PUBLIC_OFFER_SHA256" \
    --arg privacy "$EXPECTED_PRIVACY_POLICY_SHA256" \
    --arg consent "$EXPECTED_PD_CONSENT_SHA256" \
    --arg disclosure "$EXPECTED_CHECKOUT_DISCLOSURE_SHA256" '
      .payment.status == "REFUNDED"
      and .payment.captured_amount_kopecks == 100
      and .booking.status == "CANCELLED"
      and .ticket.status == "VOID"
      and (.order.customer_adult_confirmed_at | type == "string" and length > 0)
      and .order.participant_is_customer == 1
      and .order.participant_is_minor == 0
      and (.order.participant_age_at_occurrence | type == "number" and . >= 18)
      and .order.participant_requires_adult_accompaniment == 0
      and .order.minor_legal_representative_confirmed_at == null
      and .order.under_14_accompaniment_confirmed_at == null
      and .order.checkout_legal_release_id == $release
      and .order.public_offer_sha256 == $offer
      and .order.privacy_policy_sha256 == $privacy
      and .order.pd_consent_sha256 == $consent
      and .order.checkout_disclosure_sha256 == $disclosure
      and ([.tochka_webhook_events[]? | select(.provider == "TOCHKA" and .status == "APPLIED" and .entity_id == $payment)] | length >= 1)
    ' "$RUN_TMP/order-evidence.json" >/dev/null || fail "final order evidence no longer proves the certification entitlement, legal, or Tochka invariants"
}
if [[ "$PHASE" == BOOKING_CANCELLED_EMAIL_DELIVERED ]]; then wait_refund; set_phase REFUND_SUCCEEDED; fi
if [[ "$PHASE" == REFUND_SUCCEEDED ]]; then REFUND_EMAIL_JSON="$(wait_email REFUND_SUCCEEDED "$REFUND_ID")"; set_phase REFUND_EMAIL_DELIVERED; fi
if [[ "$PHASE" == REFUND_EMAIL_DELIVERED ]]; then
  close_and_hide
  set_phase OCCURRENCE_CLEANED
fi
if [[ "$PHASE" == OCCURRENCE_CLEANED ]]; then
  assert_system_evidence
  # Never let the durable checkpoint itself substitute for current public and
  # Admin facts: an external reopen after a crash must prevent a PASS artifact.
  assert_cleanup_evidence
  assert_occurrence_availability 1 "final customer-cancellation availability"
  read_order_evidence
  assert_final_order_evidence
  assert_final_refund_evidence
  [[ -n "${HUMAN_TICKET_VERIFIED_AT:-}" ]] || fail "durable human ticket verification checkpoint is absent"
  assert_final_email_evidence
  COMPLETED_AT="${COMPLETED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; save_state
  ARTIFACT_DIR="$PWD/artifacts/certification"; mkdir -p "$ARTIFACT_DIR"; chmod 700 "$ARTIFACT_DIR"; MANIFEST="$ARTIFACT_DIR/flexperiment-production-e2e-${RUN_ID}.json"
  MANIFEST_TMP="$MANIFEST.tmp"
  jq -n --slurpfile system "$RUN_TMP/system-evidence.json" --slurpfile evidence "$RUN_TMP/order-evidence.json" --slurpfile occurrence_evidence "$RUN_TMP/occurrence.json" --arg run "$RUN_ID" --arg started "$STARTED_AT" --arg completed "$COMPLETED_AT" --arg occurrence_id "$OCCURRENCE_ID" --arg status "$STATUS_ID" --arg booking "$BOOKING_ID" --arg ticket "$TICKET_ID" --arg human_verified_at "$HUMAN_TICKET_VERIFIED_AT" --arg obligation "$REFUND_OBLIGATION_ID" --arg refund "$REFUND_ID" --argjson initial_availability "$INITIAL_AVAILABILITY" --argjson paid_availability "$PAID_AVAILABILITY" --argjson post_cancel_availability "$POST_CANCEL_AVAILABILITY" --argjson ticket_email "$TICKET_FINAL_EMAIL_JSON" --argjson booking_cancelled_email "$BOOKING_CANCELLED_FINAL_EMAIL_JSON" --argjson refund_succeeded_email "$REFUND_SUCCEEDED_FINAL_EMAIL_JSON" '
    def email_evidence($outbox):
      {outbox:$outbox,provider_events:[$evidence[0].email_provider_events[] | select(.outbox_id == $outbox.id)]};
    {result:"PASS",run_id:$run,environment:"production",started_at:$started,completed_at:$completed,build:$system[0],occurrence:{id:$occurrence_id,final_sales_status:$occurrence_evidence[0].sales_status,final_visibility:$occurrence_evidence[0].visibility,public_cleanup_verified:true,availability:{before_payment:$initial_availability,after_payment:$paid_availability,after_customer_cancellation:$post_cancel_availability}},order:{id:$evidence[0].order.id,status_id:$status,currency:$evidence[0].order.currency,legal_snapshot:{release_id:$evidence[0].order.checkout_legal_release_id,public_offer:{version:$evidence[0].order.public_offer_version,sha256:$evidence[0].order.public_offer_sha256},privacy_policy:{version:$evidence[0].order.privacy_policy_version,sha256:$evidence[0].order.privacy_policy_sha256},pd_consent:{version:$evidence[0].order.pd_consent_version,sha256:$evidence[0].order.pd_consent_sha256},checkout_disclosure:{version:$evidence[0].order.checkout_disclosure_version,sha256:$evidence[0].order.checkout_disclosure_sha256}},participant_assertions:{customer_adult_confirmed:($evidence[0].order.customer_adult_confirmed_at != null),participant_is_customer:($evidence[0].order.participant_is_customer == 1),participant_is_minor:($evidence[0].order.participant_is_minor == 1),adult_self_participant_verified:($evidence[0].order.customer_adult_confirmed_at != null and $evidence[0].order.participant_is_customer == 1 and $evidence[0].order.participant_is_minor == 0 and $evidence[0].order.participant_age_at_occurrence >= 18 and $evidence[0].order.participant_requires_adult_accompaniment == 0 and $evidence[0].order.minor_legal_representative_confirmed_at == null and $evidence[0].order.under_14_accompaniment_confirmed_at == null)}},payment:$evidence[0].payment,tochka_webhook_events:$evidence[0].tochka_webhook_events,booking:{id:$booking,before_cancellation:"CONFIRMED",after_cancellation:$evidence[0].booking.status},ticket:{id:$ticket,before_cancellation:"VALID",after_cancellation:$evidence[0].ticket.status,human_verified:true,human_verified_at:$human_verified_at},emails:{ticket:email_evidence($ticket_email),booking_cancelled:email_evidence($booking_cancelled_email),refund_succeeded:email_evidence($refund_succeeded_email)},refund_obligation:($evidence[0].refund_obligation|select(.id==$obligation)),refund:($evidence[0].refunds[]|select(.id==$refund))}' > "$MANIFEST_TMP"
  certification_manifest_is_valid "$MANIFEST_TMP" "$OCCURRENCE_ID" || fail "final certification manifest is not one valid PASS object"
  chmod 600 "$MANIFEST_TMP"; mv "$MANIFEST_TMP" "$MANIFEST"
  MANIFEST_WRITTEN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; set_phase COMPLETE
fi
if [[ "$PHASE" == COMPLETE ]]; then
  MANIFEST="$PWD/artifacts/certification/flexperiment-production-e2e-${RUN_ID}.json"
  [[ -f "$MANIFEST" ]] || incomplete "completion checkpoint exists but its evidence manifest is absent"
  echo "PASS"; echo "Evidence manifest: $MANIFEST"; echo "Resume state retained for audit: $STATE_FILE"
fi
