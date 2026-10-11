import type { CollectionConfig, EmailAdapter } from "payload";

const refuseWrite = () => { throw new Error("PLATFORM_CANARY_EDITORIAL_CLOSED"); };

/** Payload's default console adapter logs recipients; never use it in preparation. */
export const closedEmail: EmailAdapter = () => ({
  name: "canary-closed", defaultFromAddress: "disabled@invalid.example", defaultFromName: "Disabled",
  sendEmail: async () => { throw new Error("PLATFORM_CANARY_EMAIL_DISABLED"); },
});

/** Hooks also cover Local API overrideAccess, before publication/manifest hooks. */
export function closedEditorial(collection: CollectionConfig): CollectionConfig {
  return {
    ...collection,
    access: { ...collection.access, create: () => false, update: () => false, delete: () => false },
    hooks: {
      ...collection.hooks,
      beforeChange: [refuseWrite, ...(collection.hooks?.beforeChange ?? [])],
      beforeDelete: [refuseWrite, ...(collection.hooks?.beforeDelete ?? [])],
    },
    endpoints: Array.isArray(collection.endpoints) ? collection.endpoints.map((endpoint) => endpoint.method === "get"
      ? endpoint : { ...endpoint, handler: () => Response.json({ code: "PLATFORM_CANARY_EDITORIAL_CLOSED" }, { status: 403, headers: { "Cache-Control": "no-store" } }) }) : collection.endpoints,
  };
}
