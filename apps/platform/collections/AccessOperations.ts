import type { CollectionConfig } from "payload";
import { authorOnly } from "@/lib/access";

export const AccessOperations: CollectionConfig = {
  slug: "access-operations",
  admin: {
    useAsTitle: "operationId",
    defaultColumns: ["operationId", "courseRef", "committedVersion", "state", "updatedAt"],
    group: "System",
  },
  access: {
    read: authorOnly,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: "operationId", type: "text", required: true, unique: true, index: true },
    { name: "courseRef", type: "text", required: true, index: true },
    { name: "committedVersion", type: "number", required: true, min: 1, index: true },
    {
      name: "state",
      type: "select",
      required: true,
      defaultValue: "COMMITTED_UNACKED",
      options: ["COMMITTED_UNACKED", "ACKED"],
      index: true,
    },
    { name: "acknowledgedAt", type: "date" },
  ],
};
