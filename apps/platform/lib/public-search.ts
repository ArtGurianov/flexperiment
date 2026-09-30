import type { CourseCommercialSummary } from "./commerce-summary";
import type { PublicSearchDocument } from "./content/public";

export type PublicSearchIndexEntry = Omit<PublicSearchDocument, "courseRef">;

export function buildPublicSearchIndex(
  documents: readonly PublicSearchDocument[],
  commercial: ReadonlyMap<string, CourseCommercialSummary>,
): PublicSearchIndexEntry[] {
  return documents.flatMap(({ courseRef, ...document }) => commercial.get(courseRef)?.withdrawn ? [] : [document]);
}
