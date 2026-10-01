import type { CollectionConfig } from "payload";
import { authorOrStorefront } from "@/lib/access";

/**
 * Manifest bookkeeping lives outside the versioned course document. Writing it onto the course
 * with a partial published update would publish whatever draft the author had open, so each
 * published change bumps this unversioned row instead.
 */
export const CourseManifestStates: CollectionConfig = {
  slug: "course-manifest-states",
  admin: {
    useAsTitle: "courseRef",
    defaultColumns: ["courseRef", "manifestVersion", "publicContentUpdatedAt", "invalidatedVersion"],
    group: "System",
  },
  access: {
    read: authorOrStorefront,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: "courseRef", type: "text", required: true, unique: true, index: true },
    { name: "manifestVersion", type: "number", required: true, min: 1 },
    { name: "publicContentUpdatedAt", type: "date", required: true },
    // The last committed version whose cache invalidation and IndexNow ping have been sent.
    { name: "invalidatedVersion", type: "number", defaultValue: 0, min: 0 },
  ],
};
