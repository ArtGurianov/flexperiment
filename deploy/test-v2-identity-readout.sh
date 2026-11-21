#!/usr/bin/env bash
# Offline test for deploy/release/read-v2-identity.sh. No network.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/release/read-v2-identity.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

cat >"$tmp/fetch" <<EOF
#!/usr/bin/env bash
case "\$1" in
  https://api.flexperiment.ru/identity) echo '{"schema":"flexperiment.build-identity/1","service":"commerce-v2","sourceCommit":"$A"}' ;;
  https://courses.flexperiment.ru/identity) echo '{"schema":"flexperiment.build-identity/1","service":"platform","sourceCommit":"$B"}' ;;
  https://wrong.flexperiment.ru/identity) echo '{"schema":"flexperiment.build-identity/1","service":"lab-v2","sourceCommit":"$A"}' ;;
  *) exit 7 ;;
esac
EOF
chmod +x "$tmp/fetch"
export V2_IDENTITY_FETCH="$tmp/fetch"
fail() { echo "FAIL: $*" >&2; exit 1; }

out="$(V2_COMMERCE_IDENTITY_URL=https://api.flexperiment.ru/identity \
       V2_PLATFORM_IDENTITY_URL=https://courses.flexperiment.ru/identity \
       V2_ADMIN_IDENTITY_URL=https://down.flexperiment.ru/identity "$script" "$A")"
grep -Eq "^commerce +$A +MATCHES_EXPECTED$" <<<"$out" || fail "commerce match: $out"
grep -Eq "^platform +$B +DIFFERS_FROM_EXPECTED$" <<<"$out" || fail "platform differs: $out"
grep -Eq "^admin +- +UNREACHABLE$" <<<"$out" || fail "admin unreachable: $out"

out="$("$script")"
[[ "$(grep -c NOT_CONFIGURED <<<"$out")" == 3 ]] || fail "unset urls: $out"

out="$(V2_ADMIN_IDENTITY_URL=https://wrong.flexperiment.ru/identity "$script")"
grep -Eq "^admin +- +IDENTITY_INVALID$" <<<"$out" || fail "service mismatch must be invalid: $out"

out="$(V2_COMMERCE_IDENTITY_URL=https://api.flexperiment.ru/identity "$script")"
grep -Eq "^commerce +$A +OBSERVED$" <<<"$out" || fail "no expectation: $out"

for bad in http://api.flexperiment.ru/identity https://evil.example/identity https://api.flexperiment.ru/identity?x=1; do
  if V2_COMMERCE_IDENTITY_URL="$bad" "$script" >/dev/null 2>&1; then fail "accepted url $bad"; fi
done
if "$script" not-a-sha >/dev/null 2>&1; then fail "accepted invalid expected commit"; fi
echo "v2 identity readout: OK"
