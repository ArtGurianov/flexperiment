import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { catalogConsistencyIssues } from "../src/catalog-consistency";
import { migrateV2 } from "../src/db";
import { applyCourseManifest, withManifestHash } from "../src/manifest";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
});

const addCourse = (courseRef = "course") => {
  applyCourseManifest(db, withManifestHash({
    courseRef,
    version: 1,
    visibility: "LISTED",
    sections: [{ sectionRef: `${courseRef}:section`, visibility: "LISTED", position: 0 }],
    lessons: [{
      lessonRef: `${courseRef}:lesson`, sectionRef: `${courseRef}:section`, everPublished: true,
      visibility: "LISTED", freePreview: true, position: 0,
    }],
    operations: [],
  }));
};

const addProduct = (courseRef = "course", saleMode: "CLOSED" | "PUBLIC" = "PUBLIC") => {
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES (?,?,?,?,?)`).run(`${courseRef}:product`, `course:${courseRef}`, "ONLINE_COURSE", "FREE", courseRef);
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES (?,?,?,?,?)`).run(`${courseRef}:offer`, `course:${courseRef}`, `${courseRef}:product`, 0, saleMode);
};

const addBinding = (lessonRef = "course:lesson") => {
  db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
    VALUES (?,?,?,?)`).run(lessonRef, `video:${lessonRef}`, "now", "now");
};

describe("CMS, catalogue and private-video consistency", () => {
  it("accepts a complete one-to-one course and lesson snapshot", () => {
    addCourse();
    addProduct();
    addBinding();
    expect(catalogConsistencyIssues(db)).toEqual([]);
  });

  it("reports an active course offer whose CMS course is absent", () => {
    addProduct("missing");
    expect(catalogConsistencyIssues(db)).toContainEqual({
      code: "ACTIVE_COURSE_OFFER_WITHOUT_CMS_COURSE",
      ref: "missing",
    });
  });

  it("reports projected courses and playable lessons missing their private commerce records", () => {
    addCourse();
    expect(catalogConsistencyIssues(db)).toEqual([
      { code: "CMS_COURSE_WITHOUT_PRODUCT", ref: "course" },
      { code: "PLAYABLE_LESSON_WITHOUT_VIDEO_BINDING", ref: "course:lesson" },
    ]);
  });

  it("reports a private binding whose lesson no longer exists", () => {
    addBinding("orphan");
    expect(catalogConsistencyIssues(db)).toEqual([
      { code: "VIDEO_BINDING_WITHOUT_LESSON", ref: "orphan" },
    ]);
  });
});
