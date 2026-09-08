#!/usr/bin/env bash
# Read-only verifier shared by Q6 activation replay classification and final
# reconciliation. It authorizes nothing and never reads a caller-selected
# manifest key: the Q6 API has already returned its fixed reconciliation view.
set -euo pipefail

activation_path="${1:?Pass activation-state JSON.}"
completion_path="${2:?Pass Q6 terminal completion JSON.}"
activation_id="${3:?Pass exact activation id.}"
terminal_release_id="${4:?Pass exact terminal release id.}"
source_commit="${5:?Pass exact Q6 source commit.}"
expected_revision="${6:?Pass exact pre-activation revision.}"

[[ "$activation_id" =~ ^agent-referrals-activation-[a-f0-9]{40}$ ]] || { echo AGENT_REFERRALS_ACTIVATION_EVIDENCE_OWNER_INVALID >&2; exit 2; }
[[ "$terminal_release_id" =~ ^deploy-[a-f0-9]{40}$ && "$source_commit" =~ ^[a-f0-9]{40}$ && "$expected_revision" =~ ^[0-9]+$ ]] || { echo AGENT_REFERRALS_ACTIVATION_EVIDENCE_INPUT_INVALID >&2; exit 2; }

jq -e \
  --arg owner "$activation_id" \
  --arg terminal "$terminal_release_id" \
  --arg source "$source_commit" \
  --argjson revision "$expected_revision" \
  --slurpfile completion "$completion_path" '
    .feature_state.state == "ACTIVE"
    and .feature_state.owner_id == $owner
    and .feature_state.revision == ($revision + 1)
    and .last_feature_state_event != null
    and .last_feature_state_event.from_state == "DORMANT"
    and .last_feature_state_event.to_state == "ACTIVE"
    and .last_feature_state_event.owner_id == $owner
    and .last_feature_state_event.reason == "AGENT_REFERRALS_ACTIVATION_V1"
    and .last_feature_state_event.revision == ($revision + 1)
    and .activation_manifest.version == "agent-referrals-activation-v1"
    and .activation_manifest.activation_id == $owner
    and .activation_manifest.terminal_release_id == $terminal
    and .activation_manifest.source_commit == $source
    and .activation_manifest.migration == $completion[0].expected.migration
    and .activation_manifest.legal_version == $completion[0].expected.legal_version
    and .activation_manifest.legal_manifest_sha256 == $completion[0].expected.legal_manifest_sha256
    and .activation_manifest.otp_delivery_provider == "unisender-go"
    and (.activation_manifest.otp_pepper_sha256 | type == "string" and test("^[a-f0-9]{64}$"))
    and (.activation_manifest | keys | sort) == ["activation_id", "legal_manifest_sha256", "legal_version", "migration", "otp_delivery_provider", "otp_pepper_sha256", "source_commit", "terminal_release_id", "version"]
  ' "$activation_path" >/dev/null || { echo AGENT_REFERRALS_ACTIVATION_EVIDENCE_MISMATCH >&2; exit 1; }
