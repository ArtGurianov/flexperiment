import { randomUUID } from "node:crypto";
import type { CollectionAfterOperationHook, CollectionBeforeChangeHook, CollectionBeforeDeleteHook, CollectionBeforeOperationHook, FieldHook } from "payload";
import { getDocumentForLifecycle } from "@/lib/content/editorial";

const draftOperationKey = "__lmsDraftOperation";

export const markDraftOperation: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (operation === "create" || operation === "update" || operation === "updateByID") {
    (req.context as Record<string, unknown>)[draftOperationKey] = Boolean((args as { draft?: boolean }).draft);
  }
};

export const clearDraftOperation: CollectionAfterOperationHook = ({ req, result }) => {
  delete (req.context as Record<string, unknown>)[draftOperationKey];
  return result;
};

export const immutableRef = (field: string): FieldHook => ({ originalDoc, value }) => {
  const existing = originalDoc?.[field];
  if (existing && value !== existing) throw new Error(`${field.toUpperCase()}_IMMUTABLE`);
  return existing ?? value ?? randomUUID();
};

export const immutableSlugAfterPublish: FieldHook = ({ originalDoc, value }) => {
  if (originalDoc?.everPublished && value !== originalDoc.slug) throw new Error("SLUG_IMMUTABLE_AFTER_PUBLISH");
  return value;
};

const relationValue = (value: unknown) => value && typeof value === "object" && "id" in value
  ? String((value as { id: unknown }).id)
  : String(value ?? "");

export const immutableRelationAfterPublish = (field: string): FieldHook => ({ originalDoc, value }) => {
  if (originalDoc?.everPublished && relationValue(value) !== relationValue(originalDoc[field])) {
    throw new Error(`${field.toUpperCase()}_IMMUTABLE_AFTER_PUBLISH`);
  }
  return value;
};

export const enforcePublishedLifecycle: CollectionBeforeChangeHook = ({ data, originalDoc, req }) => {
  const isDraftSave = (req.context as Record<string, unknown>)[draftOperationKey] === true;
  if (!isDraftSave && originalDoc?.everPublished && originalDoc?._status === "published" && data?._status === "draft") {
    throw new Error("EVER_PUBLISHED_CONTENT_CANNOT_BE_UNPUBLISHED");
  }
  if (data?._status === "published") data.everPublished = true;
  return data;
};

export const blockPublishedDelete: CollectionBeforeDeleteHook = async ({ id, req, collection }) => {
  const doc = await getDocumentForLifecycle(req, collection.slug, id);
  if ((doc as unknown as { everPublished?: boolean }).everPublished) throw new Error("EVER_PUBLISHED_CONTENT_CANNOT_BE_DELETED");
};
