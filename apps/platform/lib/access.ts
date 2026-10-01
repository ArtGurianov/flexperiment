import type { Access, Where } from "payload";

export const authorOnly: Access = ({ req }) => Boolean(req.user);

export const authorOrStorefront: Access = ({ req }) => Boolean(req.user) || (req.context as Record<string, unknown>)?.storefront === true;

export const publicPublishedAndListed: Access = ({ req }) => {
  if (req.user) return true;
  if ((req.context as Record<string, unknown>)?.storefront !== true) return false;
  return {
    and: [
      { _status: { equals: "published" } },
      { visibility: { equals: "listed" } },
    ],
  } as Where;
};
