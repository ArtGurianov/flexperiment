import { randomUUID } from "node:crypto";
import { TochkaProvider, providerFromEnvironment } from "./provider";

const SANDBOX_BASE_URL = "https://enter.tochka.com/sandbox/v2";
const SANDBOX_JWT = "sandbox.jwt.token";
const SANDBOX_CUSTOMER_CODE = "1234567ab";
const SANDBOX_MERCHANT_ID = "200000000001097";

const run = async () => {
  const provider = providerFromEnvironment();
  if (!(provider instanceof TochkaProvider)
    || provider.config.baseUrl !== SANDBOX_BASE_URL
    || provider.config.jwt !== SANDBOX_JWT
    || provider.config.customerCode !== SANDBOX_CUSTOMER_CODE
    || provider.config.merchantId !== SANDBOX_MERCHANT_ID) {
    throw new Error("Sandbox create probe requires the exact documented Tochka sandbox tuple.");
  }

  const paymentLinkId = randomUUID();
  await provider.createPayment({
    paymentId: paymentLinkId,
    paymentLinkId,
    amountKopecks: 100,
    idempotencyKey: paymentLinkId,
    successUrl: "https://flexperiment.ru/payment/success",
    customerEmail: "sandbox-probe@example.invalid",
    purpose: "Sandbox payment-link configuration probe",
    receiptItemName: "Sandbox payment-link configuration probe",
  });
  console.log("Tochka sandbox create probe: OK (structured payment link received)");
};

void run().catch((error: unknown) => {
  // The probe input is fixed and the provider adapter does not put credentials
  // or payment links into its error messages. Preserve the failure category so
  // sandbox contract and transport issues are actionable.
  if (error instanceof Error) console.error(`Tochka sandbox create probe: FAILED [${error.name}]: ${error.message}`);
  else console.error("Tochka sandbox create probe: FAILED: unknown error");
  process.exitCode = 1;
});
