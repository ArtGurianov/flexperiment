import { DomainError, one } from "../domain";

type CheckoutHost = any;

export const checkoutStatus = (host: CheckoutHost, statusId: string) => {
  const payment = one(host.db, `SELECT p.state, p.status, p.payment_url
    FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?`, statusId);
  if (!payment) throw new DomainError("CHECKOUT_NOT_FOUND", 404);
  return host.checkoutResult({ status_id: statusId, ...payment });
};
