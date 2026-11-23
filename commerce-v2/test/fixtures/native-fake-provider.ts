// The fake bank and fiscal adapter live in src/native-payment-fake.ts so a local/test server can use
// them; payment-mode.ts refuses NATIVE_PROVIDER=fake outside local/test.
export { FakeFiscalAdapter, FakeNativeBank, type FakeFault } from "../../src/native-payment-fake";
