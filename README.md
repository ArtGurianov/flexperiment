# Flexperiment

Flexperiment is a pnpm monorepo with separate storefront and service applications:

- `apps/platform` — course storefront and Payload authoring UI;
- `apps/lab` — LAB static storefront;
- `apps/admin` — operator control room;
- `commerce-v2` — v2 identity, catalogue, access and checkout service;
- `commerce` — frozen v1 commerce and controlled-release tooling.

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
