import { openV2Database } from "../../src/db";
import { MockPaymentRail, prepareCheckout } from "../../src/checkout";
import { testCheckoutConfig } from "./sales";

process.once("message", async (input: { filename: string; customerId: string; key: string; now: string }) => {
  const db = openV2Database(input.filename);
  try {
    const result = await prepareCheckout(db, new MockPaymentRail(), testCheckoutConfig, {
      customerId: input.customerId, customerEmail: `${input.customerId}@example.com`,
      offerRef: "lab:november", previewIdempotencyKey: input.key,
    }, input.now);
    process.send?.({ state: result.state });
  } catch (error) {
    process.send?.({ error: (error as Error).message });
  } finally { db.close(); process.disconnect(); }
});
process.send?.("ready");
