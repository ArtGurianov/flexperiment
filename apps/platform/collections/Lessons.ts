import type { CollectionConfig } from "payload";
import { authorOnly, publicPublishedAndListed } from "@/lib/access";
import { blockPublishedDelete, clearDraftOperation, enforcePublishedLifecycle, immutableRef, immutableRelationAfterPublish, immutableSlugAfterPublish, markDraftOperation } from "@/lib/content-lifecycle";
import { commitManifestChange, prepareManifestChange } from "@/lib/manifest/hooks";
import { videoUploadEndpoints } from "@/lib/video-upload-endpoints";

export const Lessons: CollectionConfig = {
  slug: "lessons",
  endpoints: videoUploadEndpoints,
  admin: { useAsTitle: "title", defaultColumns: ["title", "course", "section", "position", "visibility", "freePreview"] },
  versions: { drafts: { schedulePublish: true, autosave: true }, maxPerDoc: 50 },
  access: { read: publicPublishedAndListed, create: authorOnly, update: authorOnly, delete: authorOnly },
  hooks: {
    beforeOperation: [markDraftOperation],
    beforeChange: [enforcePublishedLifecycle, prepareManifestChange("lesson")],
    afterChange: [commitManifestChange("lesson")],
    afterOperation: [clearDraftOperation],
    beforeDelete: [blockPublishedDelete],
  },
  fields: [
    { name: "kinescopeVideo", type: "ui", admin: { components: { Field: "@/components/admin/KinescopeVideoField#KinescopeVideoField" } } },
    { name: "lessonRef", type: "text", unique: true, index: true, admin: { readOnly: true }, hooks: { beforeChange: [immutableRef("lessonRef")] } },
    { name: "course", type: "relationship", relationTo: "courses", required: true, index: true, hooks: { beforeChange: [immutableRelationAfterPublish("course")] } },
    { name: "section", type: "relationship", relationTo: "sections", required: true, index: true },
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, hooks: { beforeChange: [immutableSlugAfterPublish] } },
    { name: "description", type: "richText" },
    { name: "position", type: "number", required: true, min: 0 },
    { name: "durationSeconds", type: "number", min: 0, admin: { readOnly: true } },
    { name: "freePreview", type: "checkbox", defaultValue: false },
    { name: "visibility", type: "select", required: true, defaultValue: "listed", options: ["listed", "unlisted"], index: true },
    { name: "everPublished", type: "checkbox", defaultValue: false, admin: { readOnly: true, hidden: true } },
    {
      name: "seo", type: "group", fields: [
        { name: "title", type: "text" },
        { name: "description", type: "textarea" },
      ],
    },
  ],
  indexes: [{ fields: ["course", "slug"], unique: true }],
};
