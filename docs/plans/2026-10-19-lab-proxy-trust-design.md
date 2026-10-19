# LAB proxy trust: reserved IP and closed refusal

Accepted by OWNER on 2026-10-19: a short LAB nginx outage during redeploy is acceptable. Implement source and an isolated PoC; installation is a separate operation. ART-384 stays Done. Application integration: ART-198; infrastructure source/PoC: ART-391.

## Architecture

Traefik supplies the client address. LAB nginx resolves the approved `coolify-proxy` peer once at startup and generates both Real IP trust and original-peer checks from that same snapshot. Guest start/recovery pass only when the original socket peer matches the snapshot and Real IP replaced it with a different, non-proxy client address. Missing, malformed or stale trust returns 503 before Commerce. Other ticket/capability routes keep their existing behavior. No request header can opt into this trust.

Commerce keeps its exact `LAB_GUEST_TRUSTED_PROXY_IPS` and SQLite quotas by source and source+email. No new policy API, signature system, controller or quota store. The LAB address on the **Commerce-facing network** must be static, outside that network's dynamic IPAM range. A separate restricted ingress network isolates Traefik from Commerce. An IP on another interface is not proof of the socket source Commerce sees.

Host Docker administration is trusted. IPAM prevents automatic reuse; it does not authorize explicit `--ip`. Only the owner deployment authority may attach approved exact containers/images. An unexpected member invalidates network qualification. Application containers receive no Docker socket or management credentials.

## Scope and installation boundary

Read-only Adman inspection on 2026-10-19 found no `IPRange` on the existing `coolify` or fast-cut canary networks. Do not change their subnet/IPAM in place. Qualify separate candidate networks, exact membership and route source in an isolated local Docker PoC. Candidate addresses are examples, not installation configuration. Coolify's multi-network behavior and selected destination require actual read-back before installation. Regenerating Traefik can remove custom attachments; recovery must requalify them.

CUSTODY_IMPACT: NO for this source/isolated-test change; no VPS resource is modified. Future installation is YES: record networks/IPAM, application settings and trust addresses under their existing owners, refresh custody and prove recovery. An accepted nginx outage does not authorize shared Docker/Coolify changes or a production install.

## Implementation and verification

1. Add the LAB-only original-peer/Real IP gate for exact start/recovery locations, preserving other allowlists and no-token-logging behavior.
2. Extend real nginx + Traefik tests with untrusted peers, absent/malformed/redundant proxy addresses, proxy replacement without nginx reload, and successful recovery after nginx restart. Include a disposable broken-gate control.
3. In Adman implement read-only candidate qualification and an isolated two-network Docker PoC: address reuse, dynamic allocation while LAB is absent, explicit IP takeover limitation, unknown-member refusal, actual Commerce socket source, and network recreation.
4. Keep deployment, real Coolify qualification, capture/restore and LAB sales acceptance separate from source/PoC results. Link the two PRs and existing installation tasks.
