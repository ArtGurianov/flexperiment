# Frozen Refref purchase contract

Vendored without semantic edits from ArtGurianov/refref `93b6a41fc42b4d616f381d65573e20fceaf79e78`. Source paths: `packages/contracts/src/{purchase-manifest-v1,shared-checkout-snapshot}.ts`, `packages/contracts/schema/purchase-manifest-v2.schema.json`; conformance vectors from `scripts/fixtures/purchase-manifest-{v1,v2}`. ART-394 + ART-417, payable/2, D231.

Refresh schema, oracle and vectors together against an immutable upstream commit. These are opt-in contract oracles, never authenticated financial commands or production admission. Merchant boundary validation is in `../purchase-manifest.ts`.
