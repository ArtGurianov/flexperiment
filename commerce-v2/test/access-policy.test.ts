import { describe, expect, it } from "vitest";
import { decideLessonAccess, type LessonAccessInput } from "../src/access-policy";
import { lessonEffectiveVisibility, withManifestHash } from "../src/manifest";

const base = (): LessonAccessInput => ({
  customerId: "customer",
  courseRef: "course",
  lesson: { everPublished: true, effectiveVisibility: "LISTED", freePreview: false, withdrawn: false },
  courseProduct: { accessModel: "PAID", withdrawn: false, saleMode: "PUBLIC" },
  grants: [],
  activeDenyNonEntitledOverride: false,
  projectionStale: false,
});

describe("decideLessonAccess policy order", () => {
  it("requires a session first", () => expect(decideLessonAccess({ ...base(), customerId: undefined })).toBe("SIGN_IN_REQUIRED"));
  it("denies unknown and never-published lessons", () => {
    expect(decideLessonAccess({ ...base(), lesson: undefined })).toBe("DENY");
    expect(decideLessonAccess({ ...base(), lesson: { ...base().lesson!, everPublished: false } })).toBe("DENY");
  });
  it("withdrawal beats every grant", () => expect(decideLessonAccess({ ...base(), courseProduct: { ...base().courseProduct!, withdrawn: true }, grants: [{ scope: "ALL_COURSES", revoked: false }] })).toBe("DENY"));
  it.each(["UNLISTED", "STALE", "OVERRIDE"])("an active grant survives %s", (condition) => {
    expect(decideLessonAccess({
      ...base(),
      grants: [{ scope: "COURSE", courseRef: "course", revoked: false }],
      lesson: { ...base().lesson!, effectiveVisibility: condition === "UNLISTED" ? "UNLISTED" : "LISTED" },
      projectionStale: condition === "STALE",
      activeDenyNonEntitledOverride: condition === "OVERRIDE",
    })).toBe("ALLOW");
  });
  it("denies non-entitled viewing when stale, unlisted or overridden", () => {
    expect(decideLessonAccess({ ...base(), projectionStale: true })).toBe("DENY");
    expect(decideLessonAccess({ ...base(), lesson: { ...base().lesson!, effectiveVisibility: "UNLISTED" } })).toBe("DENY");
    expect(decideLessonAccess({ ...base(), activeDenyNonEntitledOverride: true })).toBe("DENY");
  });
  it("allows a free course or free preview only after restrictive checks", () => {
    expect(decideLessonAccess({ ...base(), courseProduct: { ...base().courseProduct!, accessModel: "FREE" } })).toBe("ALLOW");
    expect(decideLessonAccess({ ...base(), lesson: { ...base().lesson!, freePreview: true } })).toBe("ALLOW");
  });
  it("distinguishes purchase required from not for sale", () => {
    expect(decideLessonAccess(base())).toBe("PURCHASE_REQUIRED");
    expect(decideLessonAccess({ ...base(), courseProduct: { ...base().courseProduct!, saleMode: "CLOSED" } })).toBe("NOT_FOR_SALE");
  });

  it("stops section-scoped previews while preserving both lessons for an entitled customer", () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "UNLISTED" }],
      lessons: [
        { lessonRef: "preview", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true },
        { lessonRef: "paid", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false },
      ],
      operations: [],
    });
    const input = (lessonRef: "preview" | "paid", entitled: boolean): LessonAccessInput => ({
      ...base(),
      lesson: {
        ...base().lesson!,
        effectiveVisibility: lessonEffectiveVisibility(manifest, lessonRef),
        freePreview: lessonRef === "preview",
      },
      grants: entitled ? [{ scope: "COURSE", courseRef: "course", revoked: false }] : [],
    });

    expect(decideLessonAccess(input("preview", false))).toBe("DENY");
    expect(decideLessonAccess(input("paid", false))).toBe("DENY");
    expect(decideLessonAccess(input("preview", true))).toBe("ALLOW");
    expect(decideLessonAccess(input("paid", true))).toBe("ALLOW");
  });
});
