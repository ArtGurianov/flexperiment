/**
 * The candidate entry point the release-candidate workflow calls.
 *
 * The orchestration contract it would run is complete and proved against test
 * adapters (commerce/src/release/orchestrator.ts). What does not exist yet is
 * the durable side: deploy sessions, the sales gate, runtime evidence and the
 * certification capability all receive their production adapters only when the
 * launch baseline materializes the schema.
 *
 * So this refuses. It does not fall back to a mock, does not improvise
 * evidence out of /system/evidence, and does not half-run the sequence. A
 * deploy path that pretends to work is worse than one that plainly says it
 * cannot, and the guard disappears in the same change that adds the adapters.
 */
export {};

process.stderr.write("RELEASE_PRODUCTION_ADAPTERS_UNAVAILABLE: release candidate adapters are materialized with the launch baseline; " +
  "the orchestration contract is proved in commerce/test/release/orchestrator.test.ts but is not executable yet.\n");
process.exit(78);
