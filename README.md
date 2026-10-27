# Flexperiment

Flexperiment is a pnpm monorepo with separate storefront and service applications:

- `apps/platform` — Next.js SSR course storefront;
- `apps/lab` — LAB static storefront;
- `apps/admin` — unified editorial and commercial Control Room;
- `commerce-v2` — v2 identity, catalogue, access and checkout service;
- `commerce` — frozen v1 commerce and controlled-release tooling.

Commerce V2 owns course drafts and the atomic published graph; Payload is retired
from the current source and the qualified closed canary. Historical editorial
archives remain evidence, not a second writer. Public launch and operational
cleanup have their own gates (ART-41 and ART-340). See the
[publication protocol](docs/course-publication-protocol.md) and
[Refref contract status](docs/refref-v9-contract-status.md).

The transition of LMS and LAB to merchant-native Refref v10 is planned in
[docs/refref-v10](docs/refref-v10/README.md); it is a documentation draft and
does not change the running checkout.

## Local development

Install the pinned workspace dependencies, then start the application you need:

```bash
pnpm install
pnpm dev
pnpm platform:dev
pnpm admin:dev
pnpm commerce-v2:dev
```

`pnpm dev` starts `apps/lab` on the default Next.js development port. The LAB
source entry point is `apps/lab/app/page.tsx`.

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

The static LAB artifact is built with an immutable source identity and a named
canonical origin:

```bash
SOURCE_COMMIT=<40-character-git-sha> LAB_ORIGIN=https://lab.flexperiment.ru pnpm build
```

Production publication and deployment are controlled workflows. Read
`docs/release/DEPLOYMENT_INVARIANTS.md` before any release action.
