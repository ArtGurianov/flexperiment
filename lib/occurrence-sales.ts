export type PublicSalesStatus = "OPEN" | "PAUSED" | "CLOSED";

export const canRequestCheckout = (occurrence: { sales_status: PublicSalesStatus; availability: number } | undefined) =>
  occurrence?.sales_status === "OPEN" && occurrence.availability > 0;

export const isPublicOccurrenceSelectable = (occurrence: { id: string; sales_status: PublicSalesStatus; availability: number }) =>
  Boolean(occurrence.id) && (occurrence.sales_status !== "OPEN" || occurrence.availability > 0);

export const salesAnnouncement = (salesStatus: PublicSalesStatus | undefined) =>
  salesStatus === "CLOSED" ? "Продажи пока закрыты."
    : salesStatus === "PAUSED" ? "Продажи временно приостановлены."
      : "Запись на эту дату пока недоступна.";
