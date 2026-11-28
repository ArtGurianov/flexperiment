// FLEX-134 synthetic feasibility probe. No runtime route, credentials or external calls.
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateV2 } from "../../commerce-v2/src/db";

const directory = mkdtempSync(join(tmpdir(), "flex-134-export-"));
const file = join(directory, "synthetic.sqlite");
const writer = new Database(file);
const now = "2026-11-28T00:00:00.000Z";
const playbackRowsPerProfile = 20_000;
const samples = 40;
let reader: Database.Database | undefined;

try {
  writer.pragma("journal_mode=WAL");
  writer.pragma("foreign_keys=ON");
  migrateV2(writer);
  writer.exec(`
    INSERT INTO customers(id,email_normalized,display_name) VALUES
      ('a','a@example.test','Synthetic A'),('b','b@example.test','Foreign profile marker');
    INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at)
      VALUES ('demo','COURSES','synthetic','{}','2026-11-28');
    INSERT INTO cities(id,slug,title) VALUES ('x','demo','Synthetic city');
    INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
      VALUES ('event','lab:test','x','Shared synthetic LAB event','2026-12-01T08:00:00.000Z','2026-12-01T10:00:00.000Z','Europe/Moscow',20,'CONFIRMED','Synthetic venue','Synthetic address');
    INSERT INTO products(id,product_ref,kind,access_model,course_ref,occurrence_ref) VALUES
      ('lms','course:synthetic','ONLINE_COURSE','PAID','synthetic',NULL),
      ('lab','lab:test','LAB','PAID',NULL,'lab:test');
    INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id) VALUES
      ('al','a-local-course','a','FULFILLED',2000,'{}','${"a".repeat(64)}','demo'),
      ('at','a-local-ticket','a','FULFILLED',1000,'{}','${"b".repeat(64)}','demo'),
      ('bt','b-local-ticket','b','FULFILLED',1000,'{}','${"c".repeat(64)}','demo');
    INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref) VALUES
      ('ala','al','lms','course:synthetic','Synthetic LMS',2000,'local'),
      ('ata','at','lab','lab:test','Synthetic LAB',1000,'local'),
      ('btb','bt','lab','lab:test','Synthetic LAB',1000,'local');
    INSERT INTO lab_tickets(id,order_line_id,qr_sha256,issued_at,used_at,used_by) VALUES
      ('ticket-a','ata','${"d".repeat(64)}','${now}','${now}','staff-marker'),
      ('ticket-b','btb','${"e".repeat(64)}','${now}',NULL,NULL);
    INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
      VALUES ('grant-a','a','COURSE','synthetic','ala','${now}');
  `);
  const playback = writer.prepare(`INSERT INTO playback_access_events(customer_id,lesson_ref,event_type,reason,occurred_at)
    VALUES (?,?,'GRANT_ALLOWED','synthetic',?)`);
  writer.transaction(() => {
    for (const id of ["a", "b"]) {
      for (let row = 0; row < playbackRowsPerProfile; row++) playback.run(id, `lesson-${row}`, now);
    }
  })();
  writer.pragma("wal_checkpoint(TRUNCATE)");

  const snapshot = new Database(file, { readonly: true, fileMustExist: true });
  reader = snapshot;
  const profile = snapshot.prepare("SELECT email_normalized,display_name FROM customers WHERE id=?");
  const orders = snapshot.prepare("SELECT public_id,state,total_kopecks,created_at FROM orders WHERE customer_id=? ORDER BY public_id");
  const entitlements = snapshot.prepare("SELECT scope,course_ref,granted_at,revoked_at FROM course_entitlements WHERE customer_id=?");
  const tickets = snapshot.prepare(`SELECT o.public_id,p.occurrence_ref,t.issued_at,t.used_at
    FROM lab_tickets t JOIN order_lines l ON l.id=t.order_line_id JOIN products p ON p.id=l.product_id
    JOIN orders o ON o.id=l.order_id WHERE o.customer_id=?`);
  const activity = snapshot.prepare(`SELECT lesson_ref,event_type,occurred_at FROM playback_access_events
    WHERE customer_id=? ORDER BY occurred_at DESC,id DESC LIMIT ?`);
  const write = writer.prepare("UPDATE customers SET updated_at=? WHERE id='b'");
  const readMs: number[] = [], encodeMs: number[] = [], writerMs: number[] = [];
  let bytes = 0;
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const cpuStart = process.cpuUsage();
  const collect = snapshot.transaction(() => {
    const started = performance.now();
    const subject = profile.get("a");
    const writeStarted = performance.now();
    write.run(new Date().toISOString());
    const writeElapsed = performance.now() - writeStarted;
    const data = { subject, orders: orders.all("a"), entitlements: entitlements.all("a"),
      tickets: tickets.all("a"), activity: activity.all("a", playbackRowsPerProfile + 1) };
    readMs.push(performance.now() - started - writeElapsed);
    writerMs.push(writeElapsed);
    assert.equal(data.orders.length, 2);
    assert.equal(data.tickets.length, 1);
    assert.equal(data.activity.length, playbackRowsPerProfile);
    return data;
  });
  for (let sample = 0; sample < samples; sample++) {
    const data = collect();
    const started = performance.now();
    const encoded = JSON.stringify(data);
    encodeMs.push(performance.now() - started);
    assert(!/Foreign profile marker|b@example\.test|b-local-ticket|staff-marker|qr_sha256/.test(encoded));
    assert(!encoded.includes("d".repeat(64)));
    bytes = Buffer.byteLength(encoded);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  const percentiles = (numbers: number[]) => {
    const sorted = numbers.slice().sort((left, right) => left - right);
    return Object.fromEntries([0.5, 0.95].map(p => [`p${p * 100}`, Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3))]));
  };
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({ samples, sqlite: writer.prepare("SELECT sqlite_version()").pluck().get(), playbackRowsPerProfile,
    reportBytes: bytes, readMs: percentiles(readMs), encodeMs: percentiles(encodeMs), writerDuringSnapshotMs: percentiles(writerMs),
    cpuMs: (cpu.user + cpu.system) / 1000, sampledRssIncreaseBytes: peak - baseline,
    walBytesBeforeClose: statSync(`${file}-wal`).size }, null, 2));
} finally {
  reader?.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
}
