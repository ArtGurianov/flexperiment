import { migrate, openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { MockProvider } from "./provider";

const orderId = process.env.COMMERCE_CREATE_UNKNOWN_REPAIR_ORDER_ID;
const paymentId = process.env.COMMERCE_CREATE_UNKNOWN_REPAIR_PAYMENT_ID;
const orderConfirmation = process.env.COMMERCE_CREATE_UNKNOWN_REPAIR_CONFIRM_ORDER_ID;
const paymentConfirmation = process.env.COMMERCE_CREATE_UNKNOWN_REPAIR_CONFIRM_PAYMENT_ID;

if (!orderId || !paymentId || orderConfirmation !== orderId || paymentConfirmation !== paymentId) {
  throw new Error("Set COMMERCE_CREATE_UNKNOWN_REPAIR_ORDER_ID/PAYMENT_ID and matching COMMERCE_CREATE_UNKNOWN_REPAIR_CONFIRM_ORDER_ID/PAYMENT_ID.");
}

const db = openDatabase();
try {
  migrate(db);
  const repaired = new CommerceDomain(db, new MockProvider()).repairCreateUnknownPayment(orderId, paymentId);
  console.log(JSON.stringify({ order_id: orderId, payment_id: paymentId, repaired }));
} finally {
  db.close();
}
