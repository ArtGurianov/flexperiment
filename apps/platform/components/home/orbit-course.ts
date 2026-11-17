export const ORBIT_COURSE_ORDER = [
  "basics", "bonebreaking", "waving", "gliding", "pauzin",
  "connecting", "musicality", "freestyle-lab", "hat-tricks", "get-low",
] as const;

export type OrbitCourse = {
  slug: string;
  title: string;
  summary: string;
  artwork: string;
};

export type OrbitArtwork = (typeof ORBIT_COURSE_ORDER)[number];

export function isOrbitArtwork(value: string): value is OrbitArtwork {
  return ORBIT_COURSE_ORDER.some((artwork) => artwork === value);
}

const catalogueAliases: Partial<Record<OrbitArtwork, string>> = {
  basics: "groove",
  bonebreaking: "bone-breaking",
};

export function catalogueAlias(artwork: OrbitArtwork): string | undefined {
  return catalogueAliases[artwork];
}
