import { searchPlugin } from "@payloadcms/plugin-search";
import { authorOnly } from "@/lib/access";
import { getPublishedDocument, relationId, type EditorialDocument } from "@/lib/content/editorial";

const text = (document: EditorialDocument, key: string) => typeof document[key] === "string" ? document[key] : "";

export const platformSearchPlugin = searchPlugin({
  collections: ["courses", "lessons"],
  syncDrafts: false,
  deleteDrafts: true,
  skipSync: ({ doc }) => doc._status !== "published",
  searchOverrides: {
    admin: { group: "System", hidden: true },
    access: { read: authorOnly, create: () => false, update: () => false, delete: () => false },
    fields: ({ defaultFields }) => [
      ...defaultFields,
      { name: "kind", type: "select", options: ["course", "lesson"], required: true, index: true },
      { name: "courseRef", type: "text", required: true, index: true },
      { name: "sectionRef", type: "text", index: true },
      { name: "slug", type: "text", required: true },
      { name: "summary", type: "textarea" },
      { name: "visibility", type: "select", options: ["listed", "unlisted"], required: true, index: true },
      { name: "courseVisibility", type: "select", options: ["listed", "unlisted"], required: true, index: true },
      { name: "sectionVisibility", type: "select", options: ["listed", "unlisted"], index: true },
    ],
  },
  beforeSync: async ({ collectionSlug, originalDoc, req, searchDoc }) => {
    const document = originalDoc as EditorialDocument;
    if (collectionSlug === "courses") return {
      ...searchDoc,
      kind: "course",
      courseRef: text(document, "courseRef"),
      slug: text(document, "slug"),
      summary: text(document, "summary"),
      visibility: document.visibility,
      courseVisibility: document.visibility,
    };
    const [course, section] = await Promise.all([
      getPublishedDocument(req, "courses", relationId(document.course)),
      getPublishedDocument(req, "sections", relationId(document.section)),
    ]);
    if (!course || !section) throw new Error("SEARCH_PARENT_NOT_PUBLISHED");
    return {
      ...searchDoc,
      kind: "lesson",
      courseRef: text(course, "courseRef"),
      sectionRef: text(section, "sectionRef"),
      slug: text(document, "slug"),
      summary: "",
      visibility: document.visibility,
      courseVisibility: course.visibility,
      sectionVisibility: section.visibility,
    };
  },
});
