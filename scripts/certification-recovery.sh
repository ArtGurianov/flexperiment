#!/usr/bin/env bash

# Pure planner for certification.sh recovery. It has no I/O and is deliberately
# sourced only from the repository-controlled script path, never from state.
certification_pending_operation_phase_valid() {
  case "$1:$2" in
    CREATE_OCCURRENCE:NEW|PUBLISH_OCCURRENCE:OCCURRENCE_CREATED|OPEN_SALES:OCCURRENCE_PUBLISHED|CANCEL_BOOKING:TICKET_EMAIL_DELIVERED) return 0 ;;
    *) return 1 ;;
  esac
}

certification_clear_state_values() {
  unset "$@"
}

certification_occurrence_identity_valid() {
  local occurrence_file="$1" city_slug="$2" title="$3"
  jq -e --arg city "$city_slug" --arg title "$title" '
    .city_slug == $city
    and .title == $title
    and .timezone == "Asia/Novokuznetsk"
    and .price_kopecks == 100
    and .capacity == 1
  ' "$occurrence_file" >/dev/null
}

certification_order_identity_valid() {
  local evidence_file="$1" order_id="$2" status_id="$3" occurrence_id="$4" payment_id="$5" booking_id="$6" ticket_id="$7"
  jq -e \
    --arg order "$order_id" \
    --arg status "$status_id" \
    --arg occurrence "$occurrence_id" \
    --arg payment "$payment_id" \
    --arg booking "$booking_id" \
    --arg ticket "$ticket_id" '
      .order.id == $order
      and .order.public_status_id == $status
      and .order.occurrence_id == $occurrence
      and .order.amount_kopecks == 100
      and .order.currency == "RUB"
      and .payment.id == $payment
      and .booking.id == $booking
      and .ticket.id == $ticket
    ' "$evidence_file" >/dev/null
}

certification_email_evidence_row() {
  local evidence_file="$1" type="$2" ref="$3" rows row outbox_id
  rows="$(jq -cer --arg type "$type" --arg ref "$ref" '[.email_outbox[] | select(.type == $type and .payload_ref == $ref)]' "$evidence_file")" || return 1
  [[ "$(jq 'length' <<<"$rows")" == 1 ]] || return 1
  row="$(jq -cer '.[0]' <<<"$rows")" || return 1
  outbox_id="$(jq -er '.id' <<<"$row")" || return 1
  jq -e --arg outbox "$outbox_id" --argjson row "$row" '
    $row.status == "DELIVERED"
    and ($row.job_id | type == "string" and length > 0)
    and ([.email_provider_events[]? | select(
      .outbox_id == $outbox
      and .status == "DELIVERED"
      and .provider_status == "delivered"
    )] | length >= 1)
    and ([.email_provider_events[]? | select(
      .outbox_id == $outbox
      and .job_id != null
      and .job_id != $row.job_id
    )] | length == 0)
    and ([.email_provider_events[]? | select(
      .outbox_id == $outbox
      and (.status == "BOUNCED" or .status == "FAILED")
    )] | length == 0)
  ' "$evidence_file" >/dev/null || return 1
  printf '%s' "$row"
}

certification_refund_evidence_converged() {
  local evidence_file="$1" payment_id="$2" obligation_id="$3" refund_id="$4"
  jq -e --arg payment "$payment_id" --arg obligation "$obligation_id" --arg refund "$refund_id" '
    .payment.id == $payment
    and .payment.status == "REFUNDED"
    and .refund_obligation.id == $obligation
    and .refund_obligation.initial_source == "CUSTOMER_CANCELLATION_PARTIAL"
    and .refund_obligation.target_refunded_amount_kopecks == 100
    and .refund_obligation.status == "FULFILLED"
    and ([.refunds[] | select(
      .payment_id == $payment
      and .source == "REFUND_OBLIGATION"
      and .refund_obligation_id == $obligation
    )] | length == 1)
    and ([.refunds[] | select(
      .id == $refund
      and .amount_kopecks == 100
      and .status == "SUCCEEDED"
      and (.provider_reference | type == "string" and length > 0)
    )] | length == 1)
  ' "$evidence_file" >/dev/null
}

certification_manifest_is_valid() {
  local manifest_file="$1" occurrence_id="$2"
  jq -e --arg occurrence "$occurrence_id" '
    type == "object"
    and .result == "PASS"
    and (.occurrence.id | type == "string" and . == $occurrence)
    and .occurrence.final_sales_status == "CLOSED"
    and .occurrence.final_visibility == "HIDDEN"
    and .occurrence.public_cleanup_verified == true
    and .booking.after_cancellation == "CANCELLED"
    and .ticket.after_cancellation == "VOID"
    and .refund.status == "SUCCEEDED"
    and .payment.status == "REFUNDED"
  ' "$manifest_file" >/dev/null
}

certification_recovery_action() {
  local mode="$1" phase="$2" pending_operation="$3" baseline="$4" cleanup_started_at="${5:-}"

  if [[ "$mode" == cleanup ]]; then
    printf '%s\n' CLEANUP_ONLY
    return
  fi
  if [[ "$baseline" != VERIFIED ]]; then
    printf '%s\n' BLOCKED_BASELINE
    return
  fi
  # Cleanup is monotonic.  An emergency close/hide can happen while a payment
  # is in flight, so post-dispatch financial recovery remains allowed; no
  # pre-dispatch phase may create public/sellable catalog state again.
  if [[ -n "$cleanup_started_at" ]]; then
    case "$pending_operation" in
      PUBLISH_OCCURRENCE|OPEN_SALES|CREATE_OCCURRENCE)
        printf '%s\n' CLEANUP_REQUIRED
        return
        ;;
    esac
    case "$phase" in
      NEW|OCCURRENCE_CREATED|OCCURRENCE_PUBLISHED|OCCURRENCE_OPEN|QUOTE_READY)
        printf '%s\n' CLEANUP_REQUIRED
        return
        ;;
    esac
  fi
  if [[ -n "$pending_operation" ]]; then
    printf '%s\n' REPLAY_PENDING
    return
  fi
  case "$phase" in
    REFUND_EMAIL_DELIVERED) printf '%s\n' CLEAN_OCCURRENCE ;;
    OCCURRENCE_CLEANED) printf '%s\n' WRITE_MANIFEST ;;
    COMPLETE) printf '%s\n' REPORT_COMPLETE ;;
    *) printf '%s\n' CONTINUE ;;
  esac
}
