import { describe, expect, it } from "vitest";
import { decideLessonAccess, type LessonAccessInput } from "../src/access-policy";

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
});
