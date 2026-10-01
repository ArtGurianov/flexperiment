import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export type CampaignEmail = {
  recipient: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
};

type CampaignKind = "NEW_COURSE" | "NEW_LESSONS";
type CampaignLesson = { lessonRef: string; title: string; slug: string };
type CampaignCourse = { title: string; slug: string; contentVersion: string };
type CampaignPayload = { subject: string; message: string; course: CampaignCourse; lessons: CampaignLesson[] };

const cleanText = (value: unknown, code: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
};

const campaignLessons = (value: unknown): CampaignLesson[] => Array.isArray(value)
  ? value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const lesson = item as Partial<CampaignLesson>;
    return typeof lesson.lessonRef === "string" && typeof lesson.title === "string" && typeof lesson.slug === "string"
      && lesson.lessonRef.trim() && lesson.title.trim() && lesson.slug.trim()
      ? [{ lessonRef: lesson.lessonRef.trim(), title: lesson.title.trim(), slug: lesson.slug.trim() }]
      : [];
  })
  : [];

const campaignPayload = (value: Record<string, unknown>): CampaignPayload => {
  const course = value.course;
  if (!course || typeof course !== "object") throw new Error("CAMPAIGN_COURSE_REQUIRED");
  const candidate = course as Partial<CampaignCourse>;
  const lessons = campaignLessons(value.lessons);
  if (lessons.length === 0) throw new Error("NO_NEWLY_PUBLISHED_LESSONS");
  return {
    subject: cleanText(value.subject, "CAMPAIGN_SUBJECT_REQUIRED"),
    message: cleanText(value.message, "CAMPAIGN_MESSAGE_REQUIRED"),
    course: {
      title: cleanText(candidate.title, "CAMPAIGN_COURSE_TITLE_REQUIRED"),
      slug: cleanText(candidate.slug, "CAMPAIGN_COURSE_SLUG_REQUIRED"),
      contentVersion: cleanText(candidate.contentVersion, "CAMPAIGN_CONTENT_VERSION_REQUIRED"),
    },
    lessons,
  };
};

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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function createCampaign(
  db: Database.Database,
  input: { courseRef: string; idempotencyKey: string; payload: Record<string, unknown> },
) {
  const courseRef = cleanText(input.courseRef, "CAMPAIGN_COURSE_REQUIRED");
  const idempotencyKey = input.idempotencyKey.trim();
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(idempotencyKey)) throw new Error("CAMPAIGN_IDEMPOTENCY_KEY_INVALID");
  const normalized = campaignPayload(input.payload);
  const requestHash = sha256(JSON.stringify({ courseRef, payload: normalized }));

  const create = db.transaction(() => {
    const replay = db.prepare(`SELECT id,kind,payload_json,request_hash FROM notification_campaigns WHERE idempotency_key=?`)
      .get(idempotencyKey) as { id: string; kind: CampaignKind; payload_json: string; request_hash: string } | undefined;
    if (replay) {
      if (replay.request_hash !== requestHash) throw new Error("CAMPAIGN_IDEMPOTENCY_KEY_REUSED");
      return { id: replay.id, kind: replay.kind, preview: JSON.parse(replay.payload_json) as CampaignPayload, replayed: true };
    }

    const notified = previouslyNotifiedLessons(db, courseRef);
    const lessons = normalized.lessons.filter(({ lessonRef }) => !notified.has(lessonRef));
    if (lessons.length === 0) throw new Error("NO_NEWLY_PUBLISHED_LESSONS");
    const kind: CampaignKind = db.prepare("SELECT 1 FROM notification_campaigns WHERE course_ref=? AND state<>'DRAFT' LIMIT 1").get(courseRef)
      ? "NEW_LESSONS" : "NEW_COURSE";
    const id = randomUUID();
    const payload = { ...normalized, kind, lessons };
    db.prepare(`INSERT INTO notification_campaigns
      (id,course_ref,payload_json,state,kind,idempotency_key,request_hash) VALUES (?,?,?,'DRAFT',?,?,?)`)
      .run(id, courseRef, JSON.stringify(payload), kind, idempotencyKey, requestHash);
    return { id, kind, preview: payload, replayed: false };
  });
  return create.immediate();
}

const campaignAudience = (db: Database.Database, courseRef: string, kind: CampaignKind) => {
  const product = db.prepare(`SELECT access_model FROM products
    WHERE kind='ONLINE_COURSE' AND course_ref=? AND withdrawn_at IS NULL`).get(courseRef) as { access_model: "FREE" | "PAID" } | undefined;
  if (!product) throw new Error("CAMPAIGN_COURSE_NOT_ELIGIBLE");
  if (kind === "NEW_COURSE" || product.access_model === "FREE") {
    return db.prepare(`SELECT customer.id AS customer_id,customer.email_normalized FROM customers customer
      JOIN "user" auth_user ON auth_user.id=customer.auth_user_id AND auth_user.email_verified=1
      ORDER BY customer.id`).all() as Array<{ customer_id: string; email_normalized: string }>;
  }
  return db.prepare(`SELECT DISTINCT customer.id AS customer_id,customer.email_normalized FROM customers customer
    JOIN "user" auth_user ON auth_user.id=customer.auth_user_id AND auth_user.email_verified=1
    JOIN course_entitlements entitlement ON entitlement.customer_id=customer.id
    WHERE entitlement.revoked_at IS NULL
    AND (entitlement.scope='ALL_COURSES' OR (entitlement.scope='COURSE' AND entitlement.course_ref=?))
    ORDER BY customer.id`).all(courseRef) as Array<{ customer_id: string; email_normalized: string }>;
};

export function confirmCampaign(db: Database.Database, campaignId: string, actor: string, now = new Date().toISOString()) {
  const confirm = db.transaction(() => {
    const campaign = db.prepare("SELECT course_ref,payload_json,kind FROM notification_campaigns WHERE id=? AND state='DRAFT'")
      .get(campaignId) as { course_ref: string; payload_json: string; kind: CampaignKind } | undefined;
    if (!campaign) throw new Error("CAMPAIGN_NOT_CONFIRMABLE");
    const payload = JSON.parse(campaign.payload_json) as CampaignPayload;
    const notified = previouslyNotifiedLessons(db, campaign.course_ref);
    const lessons = campaignLessons(payload.lessons).filter(({ lessonRef }) => !notified.has(lessonRef));
    if (lessons.length === 0) throw new Error("NO_NEWLY_PUBLISHED_LESSONS");
    const kind: CampaignKind = db.prepare(`SELECT 1 FROM notification_campaigns
      WHERE course_ref=? AND id<>? AND state<>'DRAFT' LIMIT 1`).get(campaign.course_ref, campaignId)
      ? "NEW_LESSONS" : campaign.kind;
    const changed = db.prepare(`UPDATE notification_campaigns SET state='CONFIRMED',kind=?,payload_json=?,confirmed_by=?,confirmed_at=?,queued_at=?
      WHERE id=? AND state='DRAFT'`).run(kind, JSON.stringify({ ...payload, kind, lessons }), actor, now, now, campaignId);
    if (changed.changes !== 1) throw new Error("CAMPAIGN_NOT_CONFIRMABLE");
    const customers = campaignAudience(db, campaign.course_ref, kind)
      .filter(({ customer_id, email_normalized }) => marketingAllowed(db, customer_id, email_normalized));
    const insert = db.prepare(`INSERT INTO notification_campaign_recipients
      (id,campaign_id,customer_id,state,provider_idempotency_key) VALUES (?,?,?,'PENDING',?)
      ON CONFLICT(campaign_id,customer_id) DO NOTHING`);
    for (const customer of customers) {
      const recipientId = randomUUID();
      insert.run(recipientId, campaignId, customer.customer_id, `campaign:${campaignId}:customer:${customer.customer_id}`);
    }
    return {
      state: "QUEUED" as const,
      recipients: customers.length,
      eligibleRecipients: customers.length,
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

export function campaignStatus(db: Database.Database, campaignId: string) {
  const campaign = db.prepare(`SELECT id,kind,state,queued_at AS queuedAt,completed_at AS completedAt
    FROM notification_campaigns WHERE id=?`).get(campaignId) as {
      id: string; kind: CampaignKind; state: string; queuedAt: string | null; completedAt: string | null;
    } | undefined;
  if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
  const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN state='PENDING' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN state='SENT' THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN state LIKE 'SKIPPED_%' THEN 1 ELSE 0 END) AS skipped,
    SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed
    FROM notification_campaign_recipients WHERE campaign_id=?`).get(campaignId) as Record<string, number>;
  return { ...campaign, counts };
}

export function retryCampaign(db: Database.Database, campaignId: string, now = new Date().toISOString()) {
  const retry = db.transaction(() => {
    const campaign = db.prepare("SELECT state FROM notification_campaigns WHERE id=?").get(campaignId) as { state: string } | undefined;
    if (campaign?.state !== "FAILED") throw new Error("CAMPAIGN_NOT_RETRYABLE");
    const reset = db.prepare(`UPDATE notification_campaign_recipients
      SET state='PENDING',last_error=NULL WHERE campaign_id=? AND state='FAILED'`).run(campaignId);
    db.prepare(`UPDATE notification_campaigns SET state='CONFIRMED',queued_at=?,completed_at=NULL,dispatch_lease_expires_at=NULL
      WHERE id=? AND state='FAILED'`).run(now, campaignId);
    return { state: "QUEUED" as const, retriedRecipients: reset.changes };
  });
  return retry.immediate();
}

export async function dispatchCampaign(
  db: Database.Database,
  campaignId: string,
  input: { secret: string; publicOrigin: string; send: (message: CampaignEmail) => Promise<void> },
  now = new Date().toISOString(),
) {
  const leaseExpiresAt = new Date(new Date(now).getTime() + 60_000).toISOString();
  const acquired = db.prepare(`UPDATE notification_campaigns SET state='DISPATCHING',dispatch_lease_expires_at=?
    WHERE id=? AND (state='CONFIRMED' OR (state='DISPATCHING' AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at<=?)))`)
    .run(leaseExpiresAt, campaignId, now);
  if (acquired.changes !== 1) throw new Error("CAMPAIGN_NOT_DISPATCHABLE");
  const campaign = db.prepare("SELECT payload_json FROM notification_campaigns WHERE id=?").get(campaignId) as { payload_json: string };
  const recipients = db.prepare(`SELECT recipient.id,recipient.customer_id,recipient.provider_idempotency_key,customer.email_normalized
    FROM notification_campaign_recipients recipient JOIN customers customer ON customer.id=recipient.customer_id
    WHERE recipient.campaign_id=? AND recipient.state='PENDING' ORDER BY recipient.id`)
    .all(campaignId) as Array<{ id: string; customer_id: string; provider_idempotency_key: string; email_normalized: string }>;
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
        idempotencyKey: recipient.provider_idempotency_key,
        payload: JSON.parse(campaign.payload_json) as Record<string, unknown>,
        headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      db.prepare(`UPDATE notification_campaign_recipients SET state='SENT',sent_at=?,attempt_count=attempt_count+1 WHERE id=?`)
        .run(now, recipient.id);
    } catch (error) {
      failed += 1;
      db.prepare(`UPDATE notification_campaign_recipients SET state='FAILED',last_error=?,attempt_count=attempt_count+1 WHERE id=?`)
        .run(error instanceof Error ? error.message.slice(0, 240) : "SEND_FAILED", recipient.id);
    }
  }
  const state = failed > 0 ? "FAILED" : "COMPLETED";
  db.prepare(`UPDATE notification_campaigns SET state=?,completed_at=?,dispatch_lease_expires_at=NULL WHERE id=?`)
    .run(state, now, campaignId);
  return { processed: recipients.length, failed, state };
}

export async function dispatchPendingCampaigns(
  db: Database.Database,
  input: { secret: string; publicOrigin: string; send: (message: CampaignEmail) => Promise<void> },
  now = new Date().toISOString(),
) {
  const campaigns = db.prepare(`SELECT id FROM notification_campaigns
    WHERE state='CONFIRMED' OR (state='DISPATCHING' AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at<=?))
    ORDER BY queued_at,id LIMIT 10`).all(now) as Array<{ id: string }>;
  const results: Array<{ id: string; state: string }> = [];
  for (const campaign of campaigns) {
    try {
      const result = await dispatchCampaign(db, campaign.id, input, now);
      results.push({ id: campaign.id, state: result.state });
    } catch (error) {
      results.push({ id: campaign.id, state: error instanceof Error ? error.message : "CAMPAIGN_DISPATCH_FAILED" });
    }
  }
  return results;
}
