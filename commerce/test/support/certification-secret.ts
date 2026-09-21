import { parseCapabilityKey } from "../../src/certification/nonce";

/**
 * A capability key for tests, in the shape production uses: a version and a
 * key long enough to be one. Spelled out rather than generated so a failure is
 * reproducible, and obviously not a real secret.
 */
export const TEST_CAPABILITY_KEY = "v1:test-capability-key-not-a-real-secret-0000";
export const testSecret = () => parseCapabilityKey(TEST_CAPABILITY_KEY);
