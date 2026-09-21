import { parseCapabilityKey, parseCapabilityKeyring } from "../../src/certification/nonce";

/**
 * Capability keys for tests, in the shape production uses: a version and 32
 * decoded bytes. Derived from a fixed phrase rather than generated, so a
 * failure is reproducible and nobody mistakes these for secrets.
 */
export const TEST_CAPABILITY_KEY = "v1:3HqvmZW39UD3C_UoW0yeo4n_KXcP8LlNM7jXDbKwC28";
export const TEST_CAPABILITY_KEY_V2 = "v2:YyjfkZOVwuKzFOjJVZyraP4phmoAzLmdrRgFXHN4Woo";
export const testSecret = () => parseCapabilityKey(TEST_CAPABILITY_KEY);
export const testKeyring = () => parseCapabilityKeyring(`${TEST_CAPABILITY_KEY_V2} ${TEST_CAPABILITY_KEY}`);
