import type { CollectionConfig } from "payload";
import { authorOnly, authorOrStorefront } from "@/lib/access";

export const Media: CollectionConfig = {
  slug: "media",
  upload: {
    staticDir: process.env.PAYLOAD_MEDIA_DIR,
    imageSizes: [
      { name: "card", width: 960, height: 640, position: "centre" },
      { name: "hero", width: 1920, height: 1080, position: "centre" },
    ],
    mimeTypes: ["image/*"],
  },
  access: {
    read: authorOrStorefront,
    create: authorOnly,
    update: authorOnly,
    delete: authorOnly,
  },
  fields: [
    { name: "alt", type: "text", required: true },
  ],
};
