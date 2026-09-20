/**
 * The production certification entry point.
 *
 * The procedure it would run is complete and proved against test adapters
 * (commerce/src/certification/machine.ts): the ordering, the arm-before-send
 * discipline, the evidence classification and the refusal to resolve an
 * ambiguous provider boundary by trying again.
 *
 * What does not exist yet is the durable side. A certification capability has
 * to outlive the process that issued it and be spent exactly once, and the run
 * record has to survive the operator's laptop; both receive their storage when
 * the launch baseline materializes the schema. Until then this refuses rather
 * than improvising either, because a certification that cannot prove it spent
 * its capability once has certified nothing - and the guard disappears in the
 * same change that adds the adapters.
 */
export {};

process.stderr.write("RELEASE_PRODUCTION_ADAPTERS_UNAVAILABLE: certification capability and run storage are materialized with the launch baseline; " +
  "the procedure is proved in commerce/test/certification/machine.test.ts but is not executable yet.\n");
process.exit(78);
