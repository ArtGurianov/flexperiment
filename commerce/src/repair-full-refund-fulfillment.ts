import { migrate, openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { MockProvider } from "./provider";

const orderId = process.env.COMMERCE_FULL_REFUND_REPAIR_ORDER_ID;
const confirmation = process.env.COMMERCE_FULL_REFUND_REPAIR_CONFIRM;

if (!orderId || confirmation !== orderId) {
  throw new Error("Set COMMERCE_FULL_REFUND_REPAIR_ORDER_ID and COMMERCE_FULL_REFUND_REPAIR_CONFIRM to the same order ID.");
}

const db = openDatabase();
try {
  migrate(db);
  const repaired = new CommerceDomain(db, new MockProvider()).repairFullRefundFulfillment(orderId);
  console.log(JSON.stringify({ order_id: orderId, repaired }));
} finally {
  db.close();
}
