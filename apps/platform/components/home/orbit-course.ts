export const ORBIT_COURSE_ORDER = [
  "basics", "bonebreaking", "waving", "gliding", "pauzin",
  "connecting", "musicality", "freestyle-lab", "hat-tricks", "get-low",
] as const;

export type OrbitCourse = {
  slug: string;
  title: string;
  summary: string;
  href: string;
  artwork: string;
};
