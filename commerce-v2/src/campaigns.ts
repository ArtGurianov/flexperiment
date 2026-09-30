import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export type CampaignEmail = {
  recipient: string;
  payload: Record<string, unknown>;
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
};

type CampaignLesson = { lessonRef: string; title: string; slug: string };

const campaignLessons = (value: unknown): CampaignLesson[] => Array.isArray(value)
  ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const lesson = item as Partial<CampaignLesson>;
    return typeof lesson.lessonRef === "string" && typeof lesson.title === "string" && typeof lesson.slug === "string"
      ? [{ lessonRef: lesson.lessonRef, title: lesson.title, slug: lesson.slug }]
      : [];
  })
  : [];

const previouslyNotifiedLessons = (db: Database.Database, courseRef: string) => {
  const rows = db.prepare("SELECT payload_json FROM notification_campaigns WHERE course_ref=? AND state<>'DRAFT'")
    .all(courseRef) as Array<{ payload_json: string }>;
  return new Set(rows.flatMap(({ payload_json }) => {
    try {
      return campaignLessons((JSON.parse(payload_json) as { lessons?: unknown }).lessons).map(({ lessonRef }) => lessonRef);
    } catch {
      return [];
    }
  }));
};

export function createCampaign(db: Database.Database, input: { courseRef: string; payload: Record<string, unknown> }) {
  const notified = previouslyNotifiedLessons(db, input.courseRef);
  const lessons = campaignLessons(input.payload.lessons).filter(({ lessonRef }) => !notified.has(lessonRef));
  if (lessons.length === 0) throw new Error("NO_NEWLY_PUBLISHED_LESSONS");
  const id = randomUUID();
  const payload = { ...input.payload, lessons };
  db.prepare("INSERT INTO notification_campaigns(id,course_ref,payload_json,state) VALUES (?,?,?,'DRAFT')")
    .run(id, input.courseRef, JSON.stringify(payload));
  return { id, preview: payload };
}

export function confirmCampaign(db: Database.Database, campaignId: string, actor: string, now = new Date().toISOString()) {
  const confirm = db.transaction(() => {
    const campaign = db.prepare("SELECT course_ref,payload_json FROM notification_campaigns WHERE id=? AND state='DRAFT'")
      .get(campaignId) as { course_ref: string; payload_json: string } | undefined;
    if (!campaign) throw new Error("CAMPAIGN_NOT_CONFIRMABLE");
    const payload = JSON.parse(campaign.payload_json) as Record<string, unknown>;
    const notified = previouslyNotifiedLessons(db, campaign.course_ref);
    const lessons = campaignLessons(payload.lessons).filter(({ lessonRef }) => !notified.has(lessonRef));
    if (lessons.length === 0) throw new Error("NO_NEWLY_PUBLISHED_LESSONS");
    const changed = db.prepare(`UPDATE notification_campaigns SET state='CONFIRMED',payload_json=?,confirmed_by=?,confirmed_at=?
      WHERE id=? AND state='DRAFT'`).run(JSON.stringify({ ...payload, lessons }), actor, now, campaignId);
    if (changed.changes !== 1) throw new Error("CAMPAIGN_NOT_CONFIRMABLE");
    const customers = db.prepare(`SELECT DISTINCT entitlement.customer_id,customer.email_normalized FROM course_entitlements entitlement
      JOIN customers customer ON customer.id=entitlement.customer_id WHERE entitlement.revoked_at IS NULL
      AND (entitlement.scope='ALL_COURSES' OR (entitlement.scope='COURSE' AND entitlement.course_ref=?))`)
      .all(campaign.course_ref) as Array<{ customer_id: string; email_normalized: string }>;
    const insert = db.prepare(`INSERT INTO notification_campaign_recipients(id,campaign_id,customer_id,state)
      VALUES (?,?,?,'PENDING') ON CONFLICT(campaign_id,customer_id) DO NOTHING`);
    for (const customer of customers) insert.run(randomUUID(), campaignId, customer.customer_id);
    return {
      recipients: customers.length,
      eligibleRecipients: customers.filter(({ customer_id, email_normalized }) => marketingAllowed(db, customer_id, email_normalized)).length,
    };
  });
  return confirm.immediate();
}

const signature = (value: string, secret: string) => createHmac("sha256", secret).update(value).digest("base64url");

export function unsubscribeToken(customerId: string, secret: string) {
  const encoded = Buffer.from(customerId).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function unsubscribeCustomer(db: Database.Database, token: string, secret: string, now = new Date().toISOString()) {
  const [encoded, presented = ""] = token.split(".");
  if (!encoded) throw new Error("UNSUBSCRIBE_TOKEN_INVALID");
  const expected = signature(encoded, secret);
  const a = Buffer.from(presented); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("UNSUBSCRIBE_TOKEN_INVALID");
  const customerId = Buffer.from(encoded, "base64url").toString("utf8");
  const customer = db.prepare("SELECT email_normalized FROM customers WHERE id=?").get(customerId) as { email_normalized: string } | undefined;
  if (!customer) throw new Error("UNSUBSCRIBE_TOKEN_INVALID");
  db.prepare(`INSERT INTO email_suppressions(email_normalized,reason,created_at,removed_at) VALUES (?,'ONE_CLICK',?,NULL)
    ON CONFLICT(email_normalized) DO UPDATE SET reason='ONE_CLICK',created_at=excluded.created_at,removed_at=NULL`)
    .run(customer.email_normalized, now);
  return { unsubscribed: true };
}

const marketingAllowed = (db: Database.Database, customerId: string, email: string) => {
  const consent = db.prepare("SELECT granted FROM marketing_consents WHERE customer_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1")
    .get(customerId) as { granted: number } | undefined;
  const suppressed = db.prepare("SELECT 1 FROM email_suppressions WHERE email_normalized=? AND removed_at IS NULL").get(email);
  return consent?.granted === 1 && !suppressed;
};

export async function dispatchCampaign(
  db: Database.Database,
  campaignId: string,
  input: { secret: string; publicOrigin: string; send: (message: CampaignEmail) => Promise<void> },
  now = new Date().toISOString(),
) {
  const campaign = db.prepare("SELECT payload_json,state FROM notification_campaigns WHERE id=?").get(campaignId) as { payload_json: string; state: string } | undefined;
  if (!campaign || !["CONFIRMED", "DISPATCHING"].includes(campaign.state)) throw new Error("CAMPAIGN_NOT_DISPATCHABLE");
  db.prepare("UPDATE notification_campaigns SET state='DISPATCHING' WHERE id=?").run(campaignId);
  const recipients = db.prepare(`SELECT recipient.id,recipient.customer_id,customer.email_normalized FROM notification_campaign_recipients recipient
    JOIN customers customer ON customer.id=recipient.customer_id WHERE recipient.campaign_id=? AND recipient.state='PENDING' ORDER BY recipient.id`)
    .all(campaignId) as Array<{ id: string; customer_id: string; email_normalized: string }>;
  let failed = 0;
  for (const recipient of recipients) {
    if (!marketingAllowed(db, recipient.customer_id, recipient.email_normalized)) {
      const suppressed = db.prepare("SELECT 1 FROM email_suppressions WHERE email_normalized=? AND removed_at IS NULL").get(recipient.email_normalized);
      db.prepare("UPDATE notification_campaign_recipients SET state=? WHERE id=?")
        .run(suppressed ? "SKIPPED_SUPPRESSED" : "SKIPPED_NO_CONSENT", recipient.id);
      continue;
    }
    const token = unsubscribeToken(recipient.customer_id, input.secret);
    const unsubscribeUrl = new URL(`/v1/email/unsubscribe?token=${encodeURIComponent(token)}`, input.publicOrigin).toString();
    try {
      await input.send({
        recipient: recipient.email_normalized,
        payload: JSON.parse(campaign.payload_json) as Record<string, unknown>,
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      db.prepare("UPDATE notification_campaign_recipients SET state='SENT',sent_at=? WHERE id=?").run(now, recipient.id);
    } catch (error) {
      failed += 1;
      db.prepare("UPDATE notification_campaign_recipients SET state='FAILED',last_error=? WHERE id=?")
        .run(error instanceof Error ? error.message.slice(0, 240) : "SEND_FAILED", recipient.id);
    }
  }
  db.prepare("UPDATE notification_campaigns SET state=? WHERE id=?").run(failed > 0 ? "FAILED" : "COMPLETED", campaignId);
  return { processed: recipients.length, failed };
}
