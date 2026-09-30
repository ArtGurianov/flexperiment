import type { CourseCommercialSummary } from "./commerce-summary";
import type { PublicSearchDocument } from "./content/public";

export type PublicSearchIndexEntry = Omit<PublicSearchDocument, "courseRef" | "lastModified">;

const isSearchIndexEntry = (value: unknown): value is PublicSearchIndexEntry => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublicSearchIndexEntry>;
  return (candidate.type === "course" || candidate.type === "lesson")
    && typeof candidate.ref === "string"
    && typeof candidate.title === "string"
    && typeof candidate.summary === "string"
    && typeof candidate.url === "string"
    && candidate.url.startsWith("/courses/");
};

export function parsePublicSearchIndex(value: unknown): PublicSearchIndexEntry[] {
  return Array.isArray(value) ? value.filter(isSearchIndexEntry) : [];
}

export function buildPublicSearchIndex(
  documents: readonly PublicSearchDocument[],
  commercial: ReadonlyMap<string, CourseCommercialSummary>,
): PublicSearchIndexEntry[] {
  return documents.flatMap((document) => commercial.get(document.courseRef)?.withdrawn ? [] : [{
    type: document.type,
    ref: document.ref,
    title: document.title,
    summary: document.summary,
    url: document.url,
  }]);
}
