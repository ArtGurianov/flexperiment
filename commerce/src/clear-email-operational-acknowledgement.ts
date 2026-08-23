import { migrate, openDatabase } from "./db";
import { CommerceDomain } from "./domain";
import { MockProvider } from "./provider";

const outboxId = process.env.COMMERCE_EMAIL_UNACK_OUTBOX_ID;
const confirmation = process.env.COMMERCE_EMAIL_UNACK_CONFIRM;

if (!outboxId || confirmation !== outboxId) {
  throw new Error("Set COMMERCE_EMAIL_UNACK_OUTBOX_ID and COMMERCE_EMAIL_UNACK_CONFIRM to the same outbox ID.");
}

const db = openDatabase();
try {
  migrate(db);
  const changed = new CommerceDomain(db, new MockProvider()).clearEmailOperationalAcknowledgement(outboxId);
  console.log(JSON.stringify({ outbox_id: outboxId, changed }));
} finally {
  db.close();
}
