#!/usr/bin/env bash

# Pure planner for certification.sh recovery. It has no I/O and is deliberately
# sourced only from the repository-controlled script path, never from state.
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
  if [[ -n "$sales_cleaned_at" && ( "$pending_operation" == PUBLISH_OCCURRENCE || "$pending_operation" == OPEN_SALES ) ]]; then
    printf '%s\n' BLOCKED_AFTER_EMERGENCY_CLEANUP
    return
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
