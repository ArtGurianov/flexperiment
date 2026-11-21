import type { CourseCommercialSummary } from "./commerce-summary";

export function lessonAccessLabel(
  commercial: CourseCommercialSummary | undefined,
  freePreview: boolean,
): string {
  if (!commercial) return "Доступ уточняется";
  if (commercial.accessModel === "FREE") return "Бесплатно после записи";
  if (freePreview) return "Бесплатный превью-урок";
  return "Доступ по покупке курса";
}
