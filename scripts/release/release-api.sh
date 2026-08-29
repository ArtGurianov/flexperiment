#!/usr/bin/env bash
# Shared HTTP client for release controllers.
#
# It exists because `curl --fail-with-body` writes the body to the output file
# and reports only `curl: (22)`. During the 0039 cutover the server twice
# refused with a precise reason - CERTIFICATION_PAYMENT_REFUND_MISSING, then
# CERTIFICATION_CLEANUP_INCOMPLETE - and the operator saw only exit code 22
# both times. The authority had already answered; the transport client threw the
# answer away.
#
# That is the seam principle applied to diagnostics: an operator must see what
# the enforcement point actually said, never a proxy signal from the client that
# happened to carry it.
#
# Drop-in for the previous helper: the response body still goes to stdout on
# success, so `api "$URL" > out.json` is unchanged. On any non-2xx the status,
# the parsed error code and message, and the raw body all go to stderr, and the
# call fails.

release_api() {
  local body status url
  url="${*: -1}"
  body="$(mktemp)"

  status="$(curl --silent --show-error --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${COMMERCE_RELEASE_CONTROL_TOKEN}" \
    -H 'Content-Type: application/json' \
    --output "$body" --write-out '%{http_code}' "$@")" || {
    {
      echo "RELEASE_API_TRANSPORT_FAILURE"
      echo "  url: ${url}"
      echo "  no HTTP response was received; this is not a server refusal"
    } >&2
    rm -f "$body"
    return 1
  }

  if [[ "$status" =~ ^2[0-9][0-9]$ ]]; then
    cat "$body"
    rm -f "$body"
    return 0
  fi

  {
    echo "RELEASE_API_REFUSED"
    echo "  HTTP ${status}"
    echo "  url: ${url}"
    if jq -e . "$body" >/dev/null 2>&1; then
      echo "  code: $(jq -r '.error.code // .code // "(none)"' "$body")"
      echo "  message: $(jq -r '.error.message // .message // "(none)"' "$body")"
      echo "  body: $(jq -c . "$body")"
    else
      # Not JSON: show it verbatim, bounded, rather than claiming no detail.
      echo "  body (non-JSON, first 2000 bytes):"
      head -c 2000 "$body"
      echo
    fi
  } >&2

  rm -f "$body"
  return 1
}

# The name every controller already calls.
api() { release_api "$@"; }
