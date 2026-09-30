import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmCampaign, createCampaign, dispatchCampaign, unsubscribeCustomer, unsubscribeToken } from "../src/campaigns";
import type { CampaignEmail } from "../src/campaigns";
import { migrateV2 } from "../src/db";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db);
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','COURSES','v1','{}','now',1)`).run();
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
    VALUES ('order','public','customer','FULFILLED',0,'{}',?,'legal')`).run("a".repeat(64));
  db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
    VALUES ('line','order','product','course:one','One',0,'v1')`).run();
  db.prepare(`INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
    VALUES ('grant','customer','COURSE','course-one','line','now')`).run();
});

describe("campaign consent boundary", () => {
  it("rechecks unsubscribe after confirmation and before dispatch", async () => {
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,recorded_at,source)
      VALUES ('consent','customer',1,'v1','2026-09-30T10:00:00Z','ACCOUNT')`).run();
    const campaign = createCampaign(db, { courseRef: "course-one", payload: { subject: "Новый урок", lessons: [{ lessonRef: "lesson-one", title: "Lesson", slug: "lesson" }] } });
    expect(confirmCampaign(db, campaign.id, "author")).toEqual({ recipients: 1, eligibleRecipients: 1 });
    unsubscribeCustomer(db, unsubscribeToken("customer", "secret"), "secret");
    const send = vi.fn(async (_message: CampaignEmail) => undefined);
    expect(await dispatchCampaign(db, campaign.id, { secret: "secret", publicOrigin: "https://flexperiment.ru", send })).toEqual({ processed: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state FROM notification_campaign_recipients").get()).toEqual({ state: "SKIPPED_SUPPRESSED" });
  });

  it("sends once with one-click unsubscribe headers when consent remains active", async () => {
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,recorded_at,source)
      VALUES ('consent','customer',1,'v1','2026-09-30T10:00:00Z','ACCOUNT')`).run();
    const campaign = createCampaign(db, { courseRef: "course-one", payload: { subject: "Новый урок", lessons: [{ lessonRef: "lesson-one", title: "Lesson", slug: "lesson" }] } });
    confirmCampaign(db, campaign.id, "author");
    const send = vi.fn(async (_message: CampaignEmail) => undefined);
    await dispatchCampaign(db, campaign.id, { secret: "secret", publicOrigin: "https://flexperiment.ru", send });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });

  it("previews only lessons not covered by a confirmed campaign", () => {
    const first = createCampaign(db, { courseRef: "course-one", payload: {
      subject: "Первый", lessons: [{ lessonRef: "lesson-one", title: "One", slug: "one" }],
    } });
    confirmCampaign(db, first.id, "author");

    const second = createCampaign(db, { courseRef: "course-one", payload: {
      subject: "Второй",
      lessons: [
        { lessonRef: "lesson-one", title: "One", slug: "one" },
        { lessonRef: "lesson-two", title: "Two", slug: "two" },
      ],
    } });
    expect(second.preview.lessons).toEqual([{ lessonRef: "lesson-two", title: "Two", slug: "two" }]);
  });

  it("rechecks new lessons at confirmation when two drafts overlap", () => {
    const input = { courseRef: "course-one", payload: {
      subject: "Урок", lessons: [{ lessonRef: "lesson-one", title: "One", slug: "one" }],
    } };
    const first = createCampaign(db, input);
    const second = createCampaign(db, input);
    confirmCampaign(db, first.id, "author");
    expect(() => confirmCampaign(db, second.id, "author")).toThrow("NO_NEWLY_PUBLISHED_LESSONS");
  });
});
