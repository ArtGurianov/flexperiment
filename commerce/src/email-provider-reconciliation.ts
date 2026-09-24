import type { DeliveryEvidence } from "./email-delivery-evidence";

/**
 * Provider observations are evidence, not a second delivery authority. Both
 * the webhook fast path and the delayed Event Dump path must enter the same
 * canonical outbox transition with the same finite status vocabulary.
 */
export type UnisenderDeliveryStatus = "accepted" | "sent" | "delivered" | "soft_bounced" | "hard_bounced" | "spam";
export type UnisenderReconciliationEvent = {
  outboxId: string;
  status: "ACCEPTED" | "SENT" | "DELIVERED" | "BOUNCED";
  providerStatus: UnisenderDeliveryStatus;
  jobId?: string;
  semanticKey: string;
  source: "WEBHOOK" | "EVENT_DUMP";
  /** Already sanitized: see email-delivery-evidence.ts. */
  delivery?: DeliveryEvidence;
};

const deliveryStatus = (providerStatus: string): UnisenderReconciliationEvent["status"] | undefined => {
  if (providerStatus === "accepted") return "ACCEPTED";
  if (providerStatus === "sent") return "SENT";
  if (providerStatus === "delivered") return "DELIVERED";
  if (providerStatus === "soft_bounced" || providerStatus === "hard_bounced" || providerStatus === "spam") return "BOUNCED";
  return undefined;
};

export const normalizeUnisenderReconciliationEvent = (input: {
  outboxId: unknown;
  providerStatus: unknown;
  jobId?: unknown;
  semanticKey: string;
  source: UnisenderReconciliationEvent["source"];
  delivery?: DeliveryEvidence;
}): UnisenderReconciliationEvent | undefined => {
  if (typeof input.outboxId !== "string" || typeof input.providerStatus !== "string") return undefined;
  const providerStatus = input.providerStatus.toLowerCase();
  const status = deliveryStatus(providerStatus);
  if (!status) return undefined;
  return {
    outboxId: input.outboxId,
    status,
    providerStatus: providerStatus as UnisenderDeliveryStatus,
    ...(typeof input.jobId === "string" ? { jobId: input.jobId } : {}),
    semanticKey: input.semanticKey,
    source: input.source,
    ...(input.delivery ? { delivery: input.delivery } : {}),
  };
};
