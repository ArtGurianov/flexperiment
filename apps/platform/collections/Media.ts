import type { CollectionConfig } from "payload";
import { authorOnly, authorOrStorefront } from "@/lib/access";

export const Media: CollectionConfig = {
  slug: "media",
  upload: {
    staticDir: process.env.PAYLOAD_MEDIA_DIR,
    formatOptions: { format: "webp", options: { quality: 86 } },
    imageSizes: [
      {
        name: "card",
        width: 960,
        height: 640,
        position: "centre",
        formatOptions: { format: "webp", options: { quality: 84 } },
      },
      {
        name: "hero",
        width: 1920,
        height: 1080,
        position: "centre",
        formatOptions: { format: "webp", options: { quality: 86 } },
      },
      {
        name: "og",
        width: 1200,
        height: 630,
        position: "centre",
        formatOptions: { format: "webp", options: { quality: 86 } },
      },
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
