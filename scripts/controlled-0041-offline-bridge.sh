#!/usr/bin/env bash
set -euo pipefail

# HISTORICAL — DO NOT EXECUTE.
#
# The only permitted 0041 Gen1-to-Gen2 bridge committed before Gen2 deployment
# completed. Gen1 can never again be a ledger reader, so retaining a replayable
# host mutation script would create a dangerous permanent execution path.
echo "0041_OFFLINE_BRIDGE_RETIRED_AFTER_GEN2_DEPLOYMENT" >&2
exit 1
