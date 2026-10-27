# Flexperiment

Flexperiment is a pnpm monorepo with separate storefront and service applications:

- `apps/platform` — Next.js SSR course storefront;
- `apps/lab-v2` — current LAB V2 static storefront and guest checkout;
- `apps/lab` — retired LAB V1 source, retained for historical checks; its public runtime is stopped;
- `apps/admin` — unified editorial and commercial Control Room;
- `commerce-v2` — v2 identity, catalogue, access and checkout service;
- `commerce` — frozen v1 commerce and controlled-release tooling.

Commerce V2 owns course drafts and the atomic published graph; Payload is retired
from the current source and the qualified closed canary. Historical editorial
archives remain evidence, not a second writer. Public launch and operational
cleanup have their own gates (ART-41 and ART-340). See the
[publication protocol](docs/course-publication-protocol.md) and
[historical Refref v9 contract status](docs/refref-v9-contract-status.md).

The proposed merchant-native transition for new LMS/LAB purchases is documented
in [Refref v10 architecture](docs/refref-v10/README.md). It is a documentation
draft with pending profile decisions, not a served API, financial activation or
permission to replace existing payment ownership.

## Local development

Install the pinned workspace dependencies, then start the application you need:

```bash
pnpm install
pnpm platform:dev
pnpm admin:dev
pnpm commerce-v2:dev
```

The legacy `pnpm dev` script still targets `apps/lab` V1; it is not the current
LAB V2 entry point and does not authorize restarting its public runtime. LAB V2
is the separate `@flexperiment/lab-v2` workspace, built by
[Dockerfile.frontends-v2](Dockerfile.frontends-v2). Public V1 hosts remain static
410 responses; historical records are not imported as fabricated V2 orders.

## Validation

```bash
pnpm --filter @flexperiment/lab exec next typegen
pnpm exec tsc --noEmit
pnpm lab:typecheck
pnpm admin:typecheck
pnpm platform:typecheck
pnpm test
pnpm platform:test
```

Legacy LAB type/build checks remain historical compatibility checks. Current
LAB V2 images carry an immutable source identity and the `lab-v2` service name
through `Dockerfile.frontends-v2`; building either artifact is not deployment or
activation authority.

The v10 documentation package has its own local integrity check:

```bash
python3 docs/refref-v10/validate-package.py
```

Production publication and deployment are controlled workflows. Read
`docs/release/DEPLOYMENT_INVARIANTS.md` before any release action.
