import type { QueryKey } from "@tanstack/react-query";
import {
  cityKeys, dashboardKeys, emailAttentionKeys, incidentKeys,
  occurrenceKeys, orderKeys, refundKeys, settlementKeys, agentKeys, promoKeys,
} from "./query-keys";

export type AdminMutation =
  | "city.create" | "city.patch"
  | "occurrence.create" | "occurrence.patch" | "occurrence.cancel" | "occurrence.complete"
  | "order.refund" | "order.abandonReservation"
  | "email.acknowledge" | "incident.resolve"
  | "settlement.paymentMade" | "settlement.documentsComplete"
  | "settlement.cancelBeforePayment" | "settlement.recovery"
  | "agent.create" | "agent.patch" | "promo.create" | "promo.patch";

export type MutationContext = {
  cityId?: string;
  occurrenceId?: string;
  orderId?: string;
  settlementId?: string;
  agentId?: string;
  promoId?: string;
};

/**
 * The single place that decides mutation -> cache consequence. No component
 * may call invalidateQueries directly — mutations declare intent here, this
 * map decides what goes stale. Every entry includes dashboardKeys.summary()
 * (A4: no mutation may leave a dashboard counter behind), and every entry
 * targets the narrowest sufficient prefix — lists()/leaf, never all() —
 * asserted by invalidation.test.ts so the request budget in lib/polling.ts
 * can't regress through over-broad invalidation.
 */
export function invalidationKeysFor(mutation: AdminMutation, ctx: MutationContext = {}): readonly QueryKey[] {
  switch (mutation) {
    case "city.create":
      return [cityKeys.lists(), dashboardKeys.summary()];
    case "city.patch":
      return [cityKeys.lists(), ...(ctx.cityId ? [cityKeys.detail(ctx.cityId)] : []), dashboardKeys.summary()];
    case "occurrence.create":
      return [occurrenceKeys.lists(), dashboardKeys.summary()];
    case "occurrence.patch":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.detail(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "occurrence.cancel":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.cancellationFinancials(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "occurrence.complete":
      return [occurrenceKeys.lists(), ...(ctx.occurrenceId ? [occurrenceKeys.detail(ctx.occurrenceId)] : []), dashboardKeys.summary()];
    case "order.refund":
      return [orderKeys.lists(), ...(ctx.orderId ? [orderKeys.evidence(ctx.orderId)] : []), refundKeys.lists(), dashboardKeys.summary()];
    case "order.abandonReservation":
      return [orderKeys.lists(), ...(ctx.orderId ? [orderKeys.evidence(ctx.orderId)] : []), dashboardKeys.summary()];
    case "email.acknowledge":
      return [emailAttentionKeys.lists(), dashboardKeys.summary()];
    case "incident.resolve":
      return [incidentKeys.lists(), dashboardKeys.summary()];
    case "settlement.paymentMade":
    case "settlement.documentsComplete":
    case "settlement.cancelBeforePayment":
    case "settlement.recovery":
      return [settlementKeys.lists(), ...(ctx.settlementId ? [settlementKeys.detail(ctx.settlementId)] : []), dashboardKeys.summary()];
    case "agent.create":
    case "agent.patch":
      return [agentKeys.lists(), promoKeys.lists(), dashboardKeys.summary()];
    case "promo.create":
    case "promo.patch":
      return [promoKeys.lists(), agentKeys.lists(), dashboardKeys.summary()];
  }
}

export const ALL_ADMIN_MUTATIONS: readonly AdminMutation[] = [
  "city.create", "city.patch",
  "occurrence.create", "occurrence.patch", "occurrence.cancel", "occurrence.complete",
  "order.refund", "order.abandonReservation",
  "email.acknowledge", "incident.resolve",
  "settlement.paymentMade", "settlement.documentsComplete",
  "settlement.cancelBeforePayment", "settlement.recovery",
  "agent.create", "agent.patch", "promo.create", "promo.patch",
];
