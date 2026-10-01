import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  campaignStatus,
  confirmCampaign,
  createCampaign,
  dispatchCampaign,
  retryCampaign,
  unsubscribeCustomer,
  unsubscribeToken,
  type CampaignEmail,
} from "../src/campaigns";
import { migrateV2 } from "../src/db";

let db: Database.Database;

const payload = (lessonRef = "lesson-one") => ({
  subject: "Новый урок",
  message: "Урок уже доступен",
  course: { title: "Course", slug: "course", contentVersion: "2026-09-30T10:00:00Z" },
  lessons: [{ lessonRef, title: lessonRef, slug: lessonRef }],
});

const create = (idempotencyKey: string, lessonRef = "lesson-one") => createCampaign(db, {
  courseRef: "course-one",
  idempotencyKey,
  payload: payload(lessonRef),
});

const consent = (customerId = "customer") => db.prepare(`INSERT INTO marketing_consents
  (id,customer_id,granted,document_version,document_sha256,recorded_at,source)
  VALUES (?,?,1,'v1',?,'2026-09-30T10:00:00Z','ACCOUNT')`).run(`consent-${customerId}`, customerId, "a".repeat(64));

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db);
  db.prepare(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Student','student@example.com',1)`).run();
  db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('customer','student@example.com','user')").run();
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
  it("queues on author confirmation and rechecks unsubscribe before asynchronous dispatch", async () => {
    consent();
    const campaign = create("campaign:unsubscribe");
    expect(confirmCampaign(db, campaign.id, "author")).toEqual({ state: "QUEUED", recipients: 1, eligibleRecipients: 1 });
    unsubscribeCustomer(db, unsubscribeToken("customer", "secret"), "secret");
    const send = vi.fn<(message: CampaignEmail) => Promise<void>>(async () => undefined);
    expect(await dispatchCampaign(db, campaign.id, { secret: "secret", publicOrigin: "https://flexperiment.ru", send }))
      .toEqual({ processed: 1, failed: 0, state: "COMPLETED" });
    expect(send).not.toHaveBeenCalled();
    expect(db.prepare("SELECT state FROM notification_campaign_recipients").get()).toEqual({ state: "SKIPPED_SUPPRESSED" });
  });

  it("sends once with one-click unsubscribe and a stable provider idempotency key", async () => {
    consent();
    const campaign = create("campaign:headers");
    confirmCampaign(db, campaign.id, "author");
    const send = vi.fn<(message: CampaignEmail) => Promise<void>>(async () => undefined);
    await dispatchCampaign(db, campaign.id, { secret: "secret", publicOrigin: "https://flexperiment.ru", send });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      idempotencyKey: `campaign:${campaign.id}:customer:customer`,
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    expect(campaignStatus(db, campaign.id)).toMatchObject({ state: "COMPLETED", counts: { sent: 1, failed: 0 } });
  });

  it("replays an identical author action and rejects changed content under the same key", () => {
    const first = create("campaign:stable-action");
    expect(create("campaign:stable-action")).toMatchObject({ id: first.id, replayed: true });
    expect(() => create("campaign:stable-action", "lesson-two")).toThrow("CAMPAIGN_IDEMPOTENCY_KEY_REUSED");
  });

  it("previews only lessons not covered by a confirmed campaign", () => {
    const first = create("campaign:first");
    confirmCampaign(db, first.id, "author");
    const second = createCampaign(db, {
      courseRef: "course-one",
      idempotencyKey: "campaign:second",
      payload: { ...payload(), lessons: [
        { lessonRef: "lesson-one", title: "One", slug: "one" },
        { lessonRef: "lesson-two", title: "Two", slug: "two" },
      ] },
    });
    expect(second.preview.lessons).toEqual([{ lessonRef: "lesson-two", title: "Two", slug: "two" }]);
  });

  it("rechecks new lessons at confirmation when two drafts overlap", () => {
    const first = create("campaign:overlap-one");
    const second = create("campaign:overlap-two");
    confirmCampaign(db, first.id, "author");
    expect(() => confirmCampaign(db, second.id, "author")).toThrow("NO_NEWLY_PUBLISHED_LESSONS");
  });

  it("includes verified registrants for a new course but excludes guests", () => {
    consent();
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('guest','guest@example.com')").run();
    db.prepare(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('no-consent-user','No consent','no-consent@example.com',1)`).run();
    db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('no-consent','no-consent@example.com','no-consent-user')").run();
    const campaign = create("campaign:new-course");
    expect(campaign.kind).toBe("NEW_COURSE");
    expect(confirmCampaign(db, campaign.id, "author")).toMatchObject({ recipients: 1 });
  });

  it("targets only entitled registrants for new lessons in a paid course", () => {
    db.prepare(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('other-user','Other','other@example.com',1)`).run();
    db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('other','other@example.com','other-user')").run();
    consent(); consent("other");
    confirmCampaign(db, create("campaign:paid-course").id, "author");
    const lessons = create("campaign:paid-lessons", "lesson-two");
    expect(lessons.kind).toBe("NEW_LESSONS");
    expect(confirmCampaign(db, lessons.id, "author")).toMatchObject({ recipients: 1 });
  });

  it("targets every verified registrant for new lessons in a free course", () => {
    db.prepare(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('other-user','Other','other@example.com',1)`).run();
    db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('other','other@example.com','other-user')").run();
    consent(); consent("other");
    confirmCampaign(db, create("campaign:free-course").id, "author");
    db.prepare("UPDATE products SET access_model='FREE' WHERE id='product'").run();
    const lessons = create("campaign:free-lessons", "lesson-two");
    expect(confirmCampaign(db, lessons.id, "author")).toMatchObject({ recipients: 2 });
  });

  it("keeps a failed recipient explicit and retries with the same provider key", async () => {
    consent();
    const campaign = create("campaign:retry");
    confirmCampaign(db, campaign.id, "author");
    const attempted: string[] = [];
    await dispatchCampaign(db, campaign.id, {
      secret: "secret",
      publicOrigin: "https://flexperiment.ru",
      send: async (message) => { attempted.push(message.idempotencyKey); throw new Error("AMBIGUOUS_SEND"); },
    });
    expect(campaignStatus(db, campaign.id)).toMatchObject({ state: "FAILED", counts: { failed: 1 } });
    expect(retryCampaign(db, campaign.id)).toEqual({ state: "QUEUED", retriedRecipients: 1 });
    await dispatchCampaign(db, campaign.id, {
      secret: "secret",
      publicOrigin: "https://flexperiment.ru",
      send: async (message) => { attempted.push(message.idempotencyKey); },
    });
    expect(attempted).toEqual([
      `campaign:${campaign.id}:customer:customer`,
      `campaign:${campaign.id}:customer:customer`,
    ]);
    expect(campaignStatus(db, campaign.id)).toMatchObject({ state: "COMPLETED", counts: { sent: 1 } });
  });
});
