import type { CollectionConfig } from "payload";
import { authorOnly, publicPublishedAndListed } from "@/lib/access";
import { blockPublishedDelete, clearDraftOperation, enforcePublishedLifecycle, immutableRef, immutableRelationAfterPublish, markDraftOperation } from "@/lib/content-lifecycle";
import { commitManifestChange, prepareManifestChange } from "@/lib/manifest/hooks";

export const Sections: CollectionConfig = {
  slug: "sections",
  admin: { useAsTitle: "title", defaultColumns: ["title", "course", "position", "visibility"] },
  versions: { drafts: { schedulePublish: true, autosave: true }, maxPerDoc: 50 },
  access: { read: publicPublishedAndListed, create: authorOnly, update: authorOnly, delete: authorOnly },
  hooks: {
    beforeOperation: [markDraftOperation],
    beforeChange: [enforcePublishedLifecycle, prepareManifestChange("section")],
    afterChange: [commitManifestChange("section")],
    afterOperation: [clearDraftOperation],
    beforeDelete: [blockPublishedDelete],
  },
  fields: [
    { name: "sectionRef", type: "text", unique: true, index: true, admin: { readOnly: true }, hooks: { beforeChange: [immutableRef("sectionRef")] } },
    { name: "course", type: "relationship", relationTo: "courses", required: true, index: true, hooks: { beforeChange: [immutableRelationAfterPublish("course")] } },
    { name: "title", type: "text", required: true },
    { name: "position", type: "number", required: true, min: 0 },
    { name: "visibility", type: "select", required: true, defaultValue: "listed", options: ["listed", "unlisted"], index: true },
    { name: "everPublished", type: "checkbox", defaultValue: false, admin: { readOnly: true, hidden: true } },
  ],
};
