export type PurchaseStatus = "AVAILABLE" | "SOLD_OUT" | "NOT_YET_OPEN" | "TEMPORARILY_PAUSED" | "UNAVAILABLE";

export const canRequestCheckout = (occurrence: { purchase_status: PurchaseStatus } | undefined) => occurrence?.purchase_status === "AVAILABLE";

export const purchaseStatusAnnouncement = (status: PurchaseStatus | undefined) =>
  status === "SOLD_OUT" ? "Все места на эту дату заняты."
    : status === "NOT_YET_OPEN" ? "Продажи пока закрыты."
      : status === "TEMPORARILY_PAUSED" ? "Продажи временно приостановлены."
        : "Запись на эту дату закрыта.";
