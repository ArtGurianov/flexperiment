# Isolated V2 frontend proxies

These artifacts serve only approved canary hosts; they are not production ingress configuration. `start.sh` accepts the bounded V2 Commerce upstream and uses baked service identity. Read-only readiness remains separate from guest admission.

## LAB client source (ART-198 / ART-391)

OWNER accepts a short LAB nginx outage during redeploy (2026-10-19). The accepted design is a reserved nginx address outside the dynamic IPAM range on the **Commerce-facing** network; no dynamic controller, reload API or quota migration. Network source/isolated PoC and installation/custody gates belong to [Adman ART-391](https://linear.app/art-gurianov/issue/ART-391). The current shared networks are not modified by these artifacts.

At LAB startup `lab-client-ip.sh` resolves all IPv4/IPv6 addresses for the approved `coolify-proxy` alias. One snapshot generates both exact `set_real_ip_from` directives and `geo` checks of the original socket peer. nginx validates numeric address syntax. Empty resolution refuses startup; no subnet or header fallback exists. The generated files live in `/etc/nginx/conf.d`, which must be writable container-local storage (tmpfs for read-only deployments). Neither the source directory nor a persisted policy file is written.

For exact `/v1/lab/guest/start` and `/v1/lab/guest/recover`, nginx requires a recognized original peer **and** a successful Real IP rewrite to an address outside the approved proxy set. A nonempty `$realip_remote_addr` alone proves nothing. Failure returns `503 {"code":"LAB_SOURCE_UNAVAILABLE"}` with `Cache-Control: no-store`, before Commerce or quota consumption. Client-supplied alternate address headers are removed by `proxy.conf`. Traefik must replace untrusted forwarded assertions and append the actual transport client, as exercised by the real proxy test.

Recreating Traefik with another address intentionally closes these two routes until an authorized nginx reload/restart refreshes trust. Validate exact network membership and Traefik identity/alias **before** refreshing the snapshot. Mere possession of the alias is not application authentication: host Docker/Coolify administration and the restricted network are the authority. After refresh, independently verify client source through the complete path. Never widen trust to the Docker subnet to recover service.

The exact `/v1/lab/guest/restart` route shares the capability-route allowlist; Commerce requires the guest capability and verifies retirement safety before allowing a new purchase. Extra path suffixes remain refused. Other guest capability, confirmation, refund, auth and read-only paths retain their existing checks. Admin's trusted-client configuration is unchanged. Commerce keeps its own exact `LAB_GUEST_TRUSTED_PROXY_IPS` verification and durable SQLite source/source+email quotas; the nginx gate does not replace either. ART-384 remains complete; ART-198 deployment and LAB production acceptance remain separate.

## Verification

```sh
python3 scripts/v2/test_frontend_proxy.py -v
pnpm exec vitest run commerce-v2/test/lab-guest-client-ip.test.ts commerce-v2/test/lab-guest-checkout.test.ts
```

The real nginx/Traefik suite covers forged headers, unknown peers, missing/malformed XFF, proxy-address fallback, a changed Traefik address with unchanged nginx, no upstream calls on failure, refresh recovery and a disposable broken-gate control. Config-mounted mode skips only the exported-browser-bundle probe; CI's `docker-build` job repeats the suite against actual built LAB/Admin images and runs that probe too.

CUSTODY_IMPACT: NO for this source-only/isolated-test change. Future deployment changes proxy artifacts and possibly application settings/networks: it is YES and must follow Adman's resource inventory, capture and independent restore contract. No VPS installation is performed by the tests.
