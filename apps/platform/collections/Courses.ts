import type { CollectionConfig } from "payload";
import { authorOnly, publicPublishedAndListed } from "@/lib/access";
import { blockPublishedDelete, clearDraftOperation, enforcePublishedLifecycle, immutableRef, immutableSlugAfterPublish, markDraftOperation } from "@/lib/content-lifecycle";
import { commitManifestChange, prepareManifestChange } from "@/lib/manifest/hooks";
import { courseCommercialEndpoints } from "@/lib/course-commercial-endpoints";
import { requirePublishedOfferPurpose } from "@/lib/offer-payment-purpose";

export const Courses: CollectionConfig = {
  slug: "courses",
  endpoints: courseCommercialEndpoints,
  admin: { useAsTitle: "title", defaultColumns: ["title", "visibility", "_status", "updatedAt"] },
  versions: { drafts: { schedulePublish: true, autosave: true }, maxPerDoc: 50 },
  access: { read: publicPublishedAndListed, create: authorOnly, update: authorOnly, delete: authorOnly },
  hooks: {
    beforeOperation: [markDraftOperation],
    beforeChange: [enforcePublishedLifecycle, requirePublishedOfferPurpose, prepareManifestChange("course")],
    afterChange: [commitManifestChange("course")],
    afterOperation: [clearDraftOperation],
    beforeDelete: [blockPublishedDelete],
  },
  fields: [
    { name: "commercialSummary", type: "ui", admin: { position: "sidebar", components: { Field: "@/components/admin/CourseCommercialSummaryField#CourseCommercialSummaryField" } } },
    { name: "offerPaymentPurpose", type: "ui", admin: { position: "sidebar", components: { Field: "@/components/admin/OfferPaymentPurposeField#OfferPaymentPurposeField" } } },
    { name: "campaignComposer", type: "ui", admin: { components: { Field: "@/components/admin/CourseCampaignField#CourseCampaignField" } } },
    {
      name: "sections",
      type: "join",
      collection: "sections",
      on: "course",
      orderable: true,
      defaultSort: "_sections_sections_order",
      admin: { defaultColumns: ["title", "visibility", "_status"] },
    },
    { name: "courseRef", type: "text", unique: true, index: true, admin: { readOnly: true }, hooks: { beforeChange: [immutableRef("courseRef")] } },
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, unique: true, index: true, hooks: { beforeChange: [immutableSlugAfterPublish] } },
    { name: "summary", type: "textarea", required: true },
    { name: "description", type: "richText" },
    { name: "hero", type: "upload", relationTo: "media", required: true },
    { name: "visibility", type: "select", required: true, defaultValue: "listed", options: ["listed", "unlisted"], index: true },
    { name: "everPublished", type: "checkbox", defaultValue: false, admin: { readOnly: true, hidden: true } },
    { name: "displayDate", type: "date" },
    {
      name: "seo", type: "group", fields: [
        { name: "title", type: "text" },
        { name: "description", type: "textarea" },
        { name: "image", type: "upload", relationTo: "media" },
      ],
    },
  ],
};
