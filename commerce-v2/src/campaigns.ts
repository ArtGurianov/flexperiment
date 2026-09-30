import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export type CampaignEmail = {
  recipient: string;
  payload: Record<string, unknown>;
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
};

export function createCampaign(db: Database.Database, input: { courseRef: string; payload: Record<string, unknown> }) {
  const id = randomUUID();
  db.prepare("INSERT INTO notification_campaigns(id,course_ref,payload_json,state) VALUES (?,?,?,'DRAFT')")
    .run(id, input.courseRef, JSON.stringify(input.payload));
  return id;
}

export function confirmCampaign(db: Database.Database, campaignId: string, actor: string, now = new Date().toISOString()) {
  const confirm = db.transaction(() => {
    const changed = db.prepare(`UPDATE notification_campaigns SET state='CONFIRMED',confirmed_by=?,confirmed_at=?
      WHERE id=? AND state='DRAFT'`).run(actor, now, campaignId);
    if (changed.changes !== 1) throw new Error("CAMPAIGN_NOT_CONFIRMABLE");
    const campaign = db.prepare("SELECT course_ref FROM notification_campaigns WHERE id=?").get(campaignId) as { course_ref: string };
    const customers = db.prepare(`SELECT DISTINCT customer_id FROM course_entitlements WHERE revoked_at IS NULL
      AND (scope='ALL_COURSES' OR (scope='COURSE' AND course_ref=?))`).all(campaign.course_ref) as Array<{ customer_id: string }>;
    const insert = db.prepare(`INSERT INTO notification_campaign_recipients(id,campaign_id,customer_id,state)
      VALUES (?,?,?,'PENDING') ON CONFLICT(campaign_id,customer_id) DO NOTHING`);
    for (const customer of customers) insert.run(randomUUID(), campaignId, customer.customer_id);
    return customers.length;
  });
  return { recipients: confirm.immediate() };
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
