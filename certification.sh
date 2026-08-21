#!/usr/bin/env bash
set -euo pipefail

# FLEXPERIMENT — Tochka Phase 0 production certification
# Kemerovo / 1 RUB
#
# Dependencies: curl, jq, openssl, python3, and macOS `open`.
# This script makes real production mutations. Run it only after the Commerce
# deployment is healthy and with real approved schedule and venue disclosure.

ADMIN="https://admin.flexperiment.ru"
API="https://api.flexperiment.ru"
ADMIN_ORIGIN="https://admin.flexperiment.ru"
PUBLIC_ORIGIN="https://flexperiment.ru"
TIMEZONE="Asia/Novokuznetsk"
CUSTOMER_NAME="Tochka Certification"
CITY_SLUG="kemerovo"
CITY_NAME="Кемерово"
AMOUNT_KOPECKS=100

# Supply only the CITY_ID printed by an earlier interrupted run:
#   CITY_ID_OVERRIDE='<city-id>' ./certification.sh
CITY_ID_OVERRIDE="${CITY_ID_OVERRIDE:-}"

RUN_TMP="$(mktemp -d)"
chmod 700 "$RUN_TMP"
COOKIE_JAR="$RUN_TMP/admin.cookies"
HTTP_BODY="$RUN_TMP/http-body.json"
CHECKOUT_FILE="$RUN_TMP/checkout.json"
ORDERS_FILE="$RUN_TMP/orders.json"
ORDER_FILE="$RUN_TMP/order.json"
REFUND_FILE="$RUN_TMP/refund.json"
touch "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_FILE" "$ORDERS_FILE" "$ORDER_FILE" "$REFUND_FILE"
chmod 600 "$COOKIE_JAR" "$HTTP_BODY" "$CHECKOUT_FILE" "$ORDERS_FILE" "$ORDER_FILE" "$REFUND_FILE"
trap 'rm -rf "$RUN_TMP"' EXIT INT TERM

new_key() { openssl rand -hex 16; }

request() {
  local output="$1"
  shift
  HTTP_CODE="$(curl -sS -o "$output" -w '%{http_code}' "$@")"
}

require_2xx() {
  local context="$1"
  local output="$2"
  case "$HTTP_CODE" in
    2??) ;;
    *)
      echo "ERROR: $context returned HTTP $HTTP_CODE" >&2
      jq . "$output" 2>/dev/null || cat "$output" >&2
      exit 1
      ;;
  esac
}

require_exact_code() {
  local expected="$1"
  local context="$2"
  local output="$3"
  if [[ "$HTTP_CODE" != "$expected" ]]; then
    echo "ERROR: $context expected HTTP $expected, got $HTTP_CODE" >&2
    jq . "$output" 2>/dev/null || cat "$output" >&2
    exit 1
  fi
}

echo "FLEXPERIMENT / Tochka Phase 0 / Kemerovo / 1 RUB"
echo
read -rsp "Admin password: " ADMIN_PASSWORD
echo
echo "Enter real production occurrence data (RFC 3339 with timezone offset)."
read -rp "STARTS_AT: " STARTS_AT
read -rp "ENDS_AT: " ENDS_AT
read -rp "Venue disclosure text: " VENUE_DISCLOSURE_TEXT
read -rp "VENUE_ANNOUNCE_BY: " VENUE_ANNOUNCE_BY
read -rp "Real test email: " CUSTOMER_EMAIL

python3 - "$STARTS_AT" "$ENDS_AT" "$VENUE_ANNOUNCE_BY" <<'PY'
from datetime import datetime
import sys

def parse(label, raw):
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise SystemExit(f"ERROR: {label} is not valid RFC 3339: {raw}")
    if value.tzinfo is None or value.utcoffset() is None:
        raise SystemExit(f"ERROR: {label} must include a timezone offset")
    return value

starts, ends, announce = (
    parse("STARTS_AT", sys.argv[1]),
    parse("ENDS_AT", sys.argv[2]),
    parse("VENUE_ANNOUNCE_BY", sys.argv[3]),
)
if ends <= starts:
    raise SystemExit("ERROR: ENDS_AT must be later than STARTS_AT")
if announce >= starts:
    raise SystemExit("ERROR: VENUE_ANNOUNCE_BY must be earlier than STARTS_AT")
PY
echo "Schedule and venue-disclosure timestamps: OK"

curl -fsS "$API/healthz" | jq -e '.ok == true' >/dev/null
curl -fsS "$API/readyz" | jq -e '.ok == true' >/dev/null
curl -fsS -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/legal-config" | jq -e 'type == "object"' >/dev/null
echo "Commerce API preflight: OK"

request "$HTTP_BODY" \
  -c "$COOKIE_JAR" \
  -H "Origin: $ADMIN_ORIGIN" \
  -H "Content-Type: application/json" \
  -X POST "$ADMIN/v1/admin/login" \
  --data "$(jq -nc --arg password "$ADMIN_PASSWORD" '{password:$password}')"
require_2xx "Admin login" "$HTTP_BODY"
grep -q $'\t' "$COOKIE_JAR" || { echo "ERROR: login returned no session cookie" >&2; exit 1; }
unset ADMIN_PASSWORD
echo "Admin session: OK"

if [[ -n "$CITY_ID_OVERRIDE" ]]; then
  CITY_ID="$CITY_ID_OVERRIDE"
  echo "Resuming with supplied CITY_ID=$CITY_ID"
else
  CITY_KEY="$(new_key)"
  CITY_BODY="$(jq -nc --arg slug "$CITY_SLUG" --arg name "$CITY_NAME" '{slug:$slug,name:$name,reason:"Tochka Phase 0 certification"}')"
  request "$HTTP_BODY" \
    -b "$COOKIE_JAR" \
    -H "Origin: $ADMIN_ORIGIN" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $CITY_KEY" \
    -X POST "$ADMIN/v1/admin/cities" \
    --data "$CITY_BODY"
  if [[ "$HTTP_CODE" == "409" ]]; then
    echo "ERROR: Kemerovo already exists or city creation conflicted." >&2
    jq . "$HTTP_BODY" >&2 || true
    echo "Resume only with the CITY_ID printed by the earlier run:" >&2
    echo "  CITY_ID_OVERRIDE='<city-id>' ./certification.sh" >&2
    exit 1
  fi
  require_2xx "Create Kemerovo city" "$HTTP_BODY"
  CITY_ID="$(jq -er '.id | select(type == "string" and length > 0)' "$HTTP_BODY")"
  jq -e --arg slug "$CITY_SLUG" --arg name "$CITY_NAME" '
    .slug == $slug and (.name // .title) == $name
  ' "$HTTP_BODY" >/dev/null

  request "$HTTP_BODY" \
    -b "$COOKIE_JAR" \
    -H "Origin: $ADMIN_ORIGIN" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $CITY_KEY" \
    -X POST "$ADMIN/v1/admin/cities" \
    --data "$CITY_BODY"
  require_2xx "Replay Kemerovo city creation" "$HTTP_BODY"
  jq -e --arg id "$CITY_ID" '.id == $id' "$HTTP_BODY" >/dev/null
  echo "City create and replay: OK ($CITY_ID)"
fi

OCCURRENCE_KEY="$(new_key)"
OCCURRENCE_BODY="$(jq -nc \
  --arg city_id "$CITY_ID" \
  --arg title "FLEXPERIMENT — Кемерово — Tochka certification" \
  --arg starts_at "$STARTS_AT" \
  --arg ends_at "$ENDS_AT" \
  --arg timezone "$TIMEZONE" \
  --arg disclosure "$VENUE_DISCLOSURE_TEXT" \
  --arg announce_by "$VENUE_ANNOUNCE_BY" \
  --argjson price "$AMOUNT_KOPECKS" \
  '{city_id:$city_id,title:$title,starts_at:$starts_at,ends_at:$ends_at,timezone:$timezone,price_kopecks:$price,capacity:1,venue_status:"TO_BE_ANNOUNCED",venue_disclosure_text:$disclosure,venue_announce_by:$announce_by,reason:"Tochka Phase 0 certification"}')"
request "$HTTP_BODY" \
  -b "$COOKIE_JAR" \
  -H "Origin: $ADMIN_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $OCCURRENCE_KEY" \
  -X POST "$ADMIN/v1/admin/occurrences" \
  --data "$OCCURRENCE_BODY"
require_2xx "Create certification occurrence" "$HTTP_BODY"
OCCURRENCE_ID="$(jq -er '.id | select(type == "string" and length > 0)' "$HTTP_BODY")"
jq -e --argjson amount "$AMOUNT_KOPECKS" '
  .visibility == "HIDDEN" and .sales_status == "CLOSED" and .price_kopecks == $amount and .capacity == 1
' "$HTTP_BODY" >/dev/null

request "$HTTP_BODY" \
  -b "$COOKIE_JAR" \
  -H "Origin: $ADMIN_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $OCCURRENCE_KEY" \
  -X POST "$ADMIN/v1/admin/occurrences" \
  --data "$OCCURRENCE_BODY"
require_2xx "Replay certification occurrence" "$HTTP_BODY"
jq -e --arg id "$OCCURRENCE_ID" '.id == $id and .visibility == "HIDDEN" and .sales_status == "CLOSED"' "$HTTP_BODY" >/dev/null
echo "Occurrence create and replay: OK ($OCCURRENCE_ID)"

request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/tour"
require_2xx "Read public tour before publish" "$HTTP_BODY"
jq -e --arg id "$OCCURRENCE_ID" '[.. | objects | .id?] | index($id) == null' "$HTTP_BODY" >/dev/null
request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/occurrences/$OCCURRENCE_ID"
require_exact_code 404 "Read hidden occurrence detail" "$HTTP_BODY"
echo "Hidden occurrence is not public: OK"

PUBLISH_BODY="$(jq -nc --argjson price "$AMOUNT_KOPECKS" '{price_kopecks:$price,capacity:1,sales_status:"OPEN",visibility:"PUBLISHED",reason:"Tochka Phase 0 certification"}')"
request "$HTTP_BODY" \
  -b "$COOKIE_JAR" \
  -H "Origin: $ADMIN_ORIGIN" \
  -H "Content-Type: application/json" \
  -X PATCH "$ADMIN/v1/admin/occurrences/$OCCURRENCE_ID" \
  --data "$PUBLISH_BODY"
require_2xx "Publish certification occurrence" "$HTTP_BODY"
jq -e --argjson amount "$AMOUNT_KOPECKS" '
  .visibility == "PUBLISHED" and .sales_status == "OPEN" and .price_kopecks == $amount and .capacity == 1
' "$HTTP_BODY" >/dev/null

request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/tour"
require_2xx "Read public tour after publish" "$HTTP_BODY"
jq -e --arg id "$OCCURRENCE_ID" '[.. | objects | .id?] | index($id) != null' "$HTTP_BODY" >/dev/null
request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/occurrences/$OCCURRENCE_ID"
require_2xx "Read published occurrence detail" "$HTTP_BODY"
jq -e --arg id "$OCCURRENCE_ID" '
  .id == $id and .city_slug == "kemerovo"
' "$HTTP_BODY" >/dev/null
echo "Published Kemerovo occurrence is public: OK"

CONTEXT_BODY="$(jq -nc --arg occurrence_id "$OCCURRENCE_ID" '{occurrence_id:$occurrence_id}')"
request "$HTTP_BODY" \
  -H "Origin: $PUBLIC_ORIGIN" \
  -H "Content-Type: application/json" \
  -X POST "$API/v1/public/checkout-context" \
  --data "$CONTEXT_BODY"
require_2xx "Create checkout context" "$HTTP_BODY"
QUOTE_ID="$(jq -er '.quote_id | select(type == "string" and length > 0)' "$HTTP_BODY")"

CHECKOUT_KEY="$(new_key)"
CHECKOUT_BODY="$(jq -nc \
  --arg quote_id "$QUOTE_ID" \
  --arg name "$CUSTOMER_NAME" \
  --arg email "$CUSTOMER_EMAIL" \
  '{quote_id:$quote_id,customer_name:$name,customer_email:$email,eligibility_confirmed:true,offer_accepted:true,pd_consent_accepted:true}')"
request "$CHECKOUT_FILE" \
  -H "Origin: $PUBLIC_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $CHECKOUT_KEY" \
  -X POST "$API/v1/public/checkouts" \
  --data "$CHECKOUT_BODY"
require_2xx "Create certification checkout" "$CHECKOUT_FILE"
STATUS_ID="$(jq -er '.status_id | select(type == "string" and length > 0)' "$CHECKOUT_FILE")"
PAYMENT_URL="$(jq -er '.payment_url | select(type == "string" and length > 0)' "$CHECKOUT_FILE")"
echo "Checkout created; payment URL received but not printed."

command -v open >/dev/null || { echo "ERROR: run this script on macOS with the open command" >&2; exit 1; }
open "$PAYMENT_URL"
unset PAYMENT_URL
read -rp "Complete the real 1 RUB Tochka payment, then press Enter: " _

PAYMENT_RESULT=""
for _ in $(seq 1 60); do
  request "$HTTP_BODY" -H "Origin: $PUBLIC_ORIGIN" "$API/v1/public/checkout-status/$STATUS_ID"
  require_2xx "Read checkout status" "$HTTP_BODY"
  CHECKOUT_STATUS="$(jq -r '.status // empty' "$HTTP_BODY")"
  printf 'checkout status: %s\n' "${CHECKOUT_STATUS:-UNKNOWN}"
  case "$CHECKOUT_STATUS" in
    PAID) PAYMENT_RESULT=PAID; break ;;
    FAILED) PAYMENT_RESULT=FAILED; break ;;
  esac
  sleep 5
done
if [[ "$PAYMENT_RESULT" != PAID ]]; then
  echo "ERROR: checkout did not converge to PAID; do not create another checkout." >&2
  exit 1
fi
echo "Canonical checkout status = PAID: OK"

request "$ORDERS_FILE" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" "$ADMIN/v1/admin/orders"
require_2xx "Read Admin orders" "$ORDERS_FILE"
MATCH_COUNT="$(jq --arg status_id "$STATUS_ID" --arg occurrence_id "$OCCURRENCE_ID" --argjson amount "$AMOUNT_KOPECKS" '
  [(.orders // [])[] | select(.public_status_id == $status_id and .occurrence_id == $occurrence_id and .amount_kopecks == $amount)] | length
' "$ORDERS_FILE")"
[[ "$MATCH_COUNT" -eq 1 ]] || { echo "ERROR: expected exactly one order matching this checkout" >&2; exit 1; }
ORDER_ID="$(jq -er --arg status_id "$STATUS_ID" --arg occurrence_id "$OCCURRENCE_ID" --argjson amount "$AMOUNT_KOPECKS" '
  [(.orders // [])[] | select(.public_status_id == $status_id and .occurrence_id == $occurrence_id and .amount_kopecks == $amount)][0].id
' "$ORDERS_FILE")"
request "$ORDER_FILE" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" "$ADMIN/v1/admin/orders/$ORDER_ID"
require_2xx "Read matched order" "$ORDER_FILE"
jq -e --arg order_id "$ORDER_ID" --arg status_id "$STATUS_ID" --arg occurrence_id "$OCCURRENCE_ID" --argjson amount "$AMOUNT_KOPECKS" '
  .id == $order_id and .public_status_id == $status_id and .occurrence_id == $occurrence_id and .amount_kopecks == $amount
' "$ORDER_FILE" >/dev/null
echo "Exact checkout-to-order binding: OK"

echo "Verify in the test mailbox: ticket email arrived, its capability URL opens, and ticket data is correct."
read -rp "Type yes only after ticket verification: " TICKET_CONFIRMED
[[ "$TICKET_CONFIRMED" == yes ]] || { echo "Certification stopped before refund; no refund was created."; exit 1; }

REFUND_KEY="$(new_key)"
REFUND_BODY="$(jq -nc --argjson amount "$AMOUNT_KOPECKS" '{amount_kopecks:$amount,reason:"Tochka Phase 0 certification refund",note:"Full refund of the 1 RUB certification transaction"}')"
request "$REFUND_FILE" \
  -b "$COOKIE_JAR" \
  -H "Origin: $ADMIN_ORIGIN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $REFUND_KEY" \
  -X POST "$ADMIN/v1/admin/orders/$ORDER_ID/refunds" \
  --data "$REFUND_BODY"
require_2xx "Create certification refund" "$REFUND_FILE"
REFUND_ID="$(jq -er '.id | select(type == "string" and length > 0)' "$REFUND_FILE")"

REFUND_RESULT=""
for _ in $(seq 1 120); do
  request "$REFUND_FILE" -b "$COOKIE_JAR" -H "Origin: $ADMIN_ORIGIN" "$ADMIN/v1/admin/refunds/$REFUND_ID"
  require_2xx "Read certification refund" "$REFUND_FILE"
  REFUND_STATUS="$(jq -r '.status // empty' "$REFUND_FILE")"
  printf 'refund status: %s\n' "${REFUND_STATUS:-UNKNOWN}"
  case "$REFUND_STATUS" in
    SUCCEEDED) REFUND_RESULT=SUCCEEDED; break ;;
    FAILED|REVIEW_REQUIRED) REFUND_RESULT="$REFUND_STATUS"; break ;;
  esac
  sleep 5
done

if [[ "$REFUND_RESULT" != SUCCEEDED ]]; then
  echo "Refund did not converge to SUCCEEDED (${REFUND_RESULT:-timeout}). Do not submit another refund." >&2
  cat <<EOF >&2
For manual investigation, start a fresh Admin session. The temporary cookie is
deleted when this script exits. Only after inspecting provider/local evidence:

COOKIE_JAR="\$(mktemp)"
chmod 600 "\$COOKIE_JAR"
trap 'rm -f "\$COOKIE_JAR"' EXIT INT TERM
# Login again, then:
curl -sS -b "\$COOKIE_JAR" -H 'Origin: https://admin.flexperiment.ru' \\
  'https://admin.flexperiment.ru/v1/admin/refunds/$REFUND_ID' | jq .
curl -sS -b "\$COOKIE_JAR" -H 'Origin: https://admin.flexperiment.ru' \\
  -H 'Content-Type: application/json' -X POST \\
  'https://admin.flexperiment.ru/v1/admin/refunds/$REFUND_ID/reconcile' --data '{}' | jq .
EOF
  exit 1
fi
jq -e --argjson amount "$AMOUNT_KOPECKS" '.status == "SUCCEEDED" and .amount_kopecks == $amount' "$REFUND_FILE" >/dev/null

echo
echo "PHASE 0 API-VISIBLE FLOW PASSED"
printf 'CITY_ID=%s\nOCCURRENCE_ID=%s\nSTATUS_ID=%s\nORDER_ID=%s\nREFUND_ID=%s\n' \
  "$CITY_ID" "$OCCURRENCE_ID" "$STATUS_ID" "$ORDER_ID" "$REFUND_ID"
echo "Save only these IDs as certification evidence; do not save cookies, payment URL, or ticket capability."
