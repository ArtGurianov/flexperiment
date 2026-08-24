#!/usr/bin/env bash

# Pure planner for certification.sh recovery. It has no I/O and is deliberately
# sourced only from the repository-controlled script path, never from state.
certification_pending_operation_phase_valid() {
  case "$1:$2" in
    CREATE_OCCURRENCE:NEW|PUBLISH_OCCURRENCE:OCCURRENCE_CREATED|OPEN_SALES:OCCURRENCE_PUBLISHED|CANCEL_BOOKING:TICKET_EMAIL_DELIVERED) return 0 ;;
    *) return 1 ;;
  esac
}

certification_recovery_action() {
  local mode="$1" phase="$2" pending_operation="$3" baseline="$4" sales_cleaned_at="${5:-}"

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
  if [[ -n "$sales_cleaned_at" ]]; then
    case "$pending_operation" in
      PUBLISH_OCCURRENCE|OPEN_SALES|CREATE_OCCURRENCE)
        printf '%s\n' BLOCKED_AFTER_EMERGENCY_CLEANUP
        return
        ;;
    esac
    case "$phase" in
      NEW|OCCURRENCE_CREATED|OCCURRENCE_PUBLISHED|OCCURRENCE_OPEN|QUOTE_READY)
        printf '%s\n' BLOCKED_AFTER_EMERGENCY_CLEANUP
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
