# Control Room owner commands (ART-31)

`PLATFORM_SERVICE_TOKEN` authorizes reads only. Every write it used to authorize either moved behind
the Control Room login (promotions, refund decisions and execution: `/v1/admin/v2/*`) or became an
owner command run over SSH inside the Commerce container (`commerce-v2/src/owner-cli.ts`). Sales
activation has no replacement here: the storefront switch (ART-319) replaces it.

```bash
C=flexperiment-fast-cut-canary-commerce   # the running Commerce container
cli() { docker exec -i "$C" node --import tsx commerce-v2/src/owner-cli.ts "$@"; }

cli legal-release activate --actor art < release.json   # {"storefront","version","manifest"}
cli campaign create --actor art < campaign.json          # {"courseRef","idempotencyKey","payload"}
cli campaign status <campaign-id>
cli campaign confirm <campaign-id> --actor art           # only with MARKETING_BROADCASTS_ENABLED=true
cli campaign retry <campaign-id> --actor art             # only with MARKETING_BROADCASTS_ENABLED=true
cli storefront-switch status                             # the runtime's read-back of the switch (ART-319)
cli storefront-switch preflight COURSES                  # may COURSES/LAB be opened; read-only
```

Neither switch command opens or closes anything. The switch is changed only on the host, as root,
with `scripts/v2/storefront-switch.py` ([runbook](storefront-switch-runbook.md)).

## Second factor (TOTP, RFC 6238)

The Control Room login takes the password and a 6-digit code together. Without
`CONTROL_ROOM_TOTP_KEY` or a confirmed enrollment no login is possible. There are no recovery
codes: recovery is these commands, over SSH.

```bash
cli totp enroll --actor art                          # prints the secret and an otpauth:// URI, once
echo '{"code":"123456"}' | cli totp confirm --actor art   # binds it; revokes every older session
cli totp reset --actor art                           # lost device: removes the factor, revokes sessions
cli session revoke-all --actor art
```

- Scan the URI (for example `qrencode -t ANSIUTF8 '<uri>'` on your own machine) or type the
  secret into the authenticator. The secret is never written to the audit log.
- Each code is accepted once. The code used to confirm can't be reused, so wait for the next one
  before the first login.
- A known password can check at most three codes per 30-second step; the per-IP limits and the
  account delay apply as before, counted per login request.
- Losing `CONTROL_ROOM_TOTP_KEY` makes the stored seed unreadable: set a new key, then `totp reset`
  and enroll again. No other data depends on it.

## Behaviour

- Each write commits together with a Control Room audit row by `owner-cli:<actor>`; if the audit
  row cannot be written, nothing is written.
- The command opens only the existing database and never migrates it; the server owns migrations.
- A confirmed campaign is delivered by the server's dispatch sweep, behind the erasure fence. The
  command never sends email.
- Output is one JSON line; a refusal prints only its code and exits 1.
