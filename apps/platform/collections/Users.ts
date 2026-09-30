import type { CollectionConfig } from "payload";
import { authorOnly } from "@/lib/access";

export const Users: CollectionConfig = {
  slug: "users",
  auth: true,
  admin: { useAsTitle: "email" },
  access: {
    create: async ({ req }) => {
      if (req.user) return true;
      const { totalDocs } = await req.payload.count({ collection: "users", overrideAccess: true, req });
      return totalDocs === 0;
    },
    read: authorOnly,
    update: authorOnly,
    delete: authorOnly,
  },
  fields: [],
};
