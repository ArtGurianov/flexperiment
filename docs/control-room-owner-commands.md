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
```

- Each write commits together with a Control Room audit row by `owner-cli:<actor>`; if the audit
  row cannot be written, nothing is written.
- The command opens only the existing database and never migrates it; the server owns migrations.
- A confirmed campaign is delivered by the server's dispatch sweep, behind the erasure fence. The
  command never sends email.
- Output is one JSON line; a refusal prints only its code and exits 1.
