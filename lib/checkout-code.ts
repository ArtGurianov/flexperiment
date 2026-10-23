export type CheckoutCodeOutcome = "NONE" | "APPLIED" | "NOT_APPLICABLE" | "NOT_RECOGNIZED" | "NOT_APPLIED_ATTRIBUTION_LOCKED" | "NOT_APPLIED_CUSTOMER_KEPT_CURRENT" | "ALREADY_APPLIED_BY_ARRIVAL" | "NOT_APPLIED_ARRIVAL_PRIORITY" | "NOT_APPLIED_CAMPAIGN_PAUSED";

export function checkoutCodeMessage(merchantPromotionCode: string | null, outcome: CheckoutCodeOutcome) {
  if (merchantPromotionCode) return `Промокод ${merchantPromotionCode} применён.`;
  switch (outcome) {
    case "ALREADY_APPLIED_BY_ARRIVAL": return "Скидка по этой рекомендации уже применена.";
    case "NOT_APPLIED_ARRIVAL_PRIORITY": return "Код не применён: сохранена скидка по вашей рекомендации.";
    case "NOT_APPLIED_CAMPAIGN_PAUSED": return "Кампания приостановлена; код не применён.";
    case "APPLIED": return "Код Refref применён.";
    case "NOT_RECOGNIZED": return "Код не распознан; цена без скидки Refref.";
    case "NOT_APPLICABLE": return "Код неприменим к этому предложению.";
    case "NOT_APPLIED_ATTRIBUTION_LOCKED": return "Код не применён: текущая атрибуция зафиксирована.";
    case "NOT_APPLIED_CUSTOMER_KEPT_CURRENT": return "Сохранена текущая атрибуция.";
    case "NONE": return "";
  }
}
