export type CheckoutCodeOutcome = "NONE" | "APPLIED" | "NOT_APPLICABLE" | "NOT_RECOGNIZED" | "NOT_APPLIED_ATTRIBUTION_LOCKED" | "NOT_APPLIED_CUSTOMER_KEPT_CURRENT";

export function checkoutCodeMessage(merchantPromotionCode: string | null, outcome: CheckoutCodeOutcome) {
  if (merchantPromotionCode) return `Промокод ${merchantPromotionCode} применён.`;
  switch (outcome) {
    case "APPLIED": return "Код Refref применён.";
    case "NOT_RECOGNIZED": return "Код не распознан; цена без скидки Refref.";
    case "NOT_APPLICABLE": return "Код неприменим к этому предложению.";
    case "NOT_APPLIED_ATTRIBUTION_LOCKED": return "Код не применён: текущая атрибуция зафиксирована.";
    case "NOT_APPLIED_CUSTOMER_KEPT_CURRENT": return "Сохранена текущая атрибуция.";
    case "NONE": return "";
  }
}
