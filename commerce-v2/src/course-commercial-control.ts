import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { configureProduct } from "./catalog-control";
import type { CommerceRuntimeConfig } from "./payment-mode";

export type CourseCommercialCommand = {
  courseRef: string; accessModel: "FREE" | "PAID"; priceKopecks: number;
  expectedVersion: number; actor: string; commandKey: string;
};
export type CourseCommercialResult = {
  productRef: string; offerRef: string; version: number; accessModel: "FREE" | "PAID";
  priceKopecks: number; saleMode: "CLOSED";
};

/** Scoped CMS command: never opens sales or accepts browser-supplied product identities. */
export function configureCourseCommercial(db: Database.Database, config: CommerceRuntimeConfig,
  input: CourseCommercialCommand, now = new Date().toISOString()): CourseCommercialResult {
  if (typeof input.courseRef !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.courseRef)
    || typeof input.actor !== "string" || !/^payload:[a-zA-Z0-9_-]{1,100}$/.test(input.actor)
    || typeof input.commandKey !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.commandKey)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !["FREE", "PAID"].includes(input.accessModel)) throw new Error("COURSE_COMMERCIAL_COMMAND_INVALID");
  if (!Number.isSafeInteger(input.priceKopecks) || (input.accessModel === "FREE" ? input.priceKopecks !== 0 : input.priceKopecks <= 0)) {
    throw new Error("COURSE_PRICE_INVALID");
  }
  const digest = createHash("sha256").update(JSON.stringify([input.accessModel, input.priceKopecks, input.expectedVersion])).digest("hex");
  return db.transaction(() => {
    const prior = db.prepare(`SELECT request_sha256,result_json FROM course_commercial_commands
      WHERE actor=? AND course_ref=? AND command_key=?`).get(input.actor, input.courseRef, input.commandKey) as
      { request_sha256: string; result_json: string } | undefined;
    if (prior) {
      if (prior.request_sha256 !== digest) throw new Error("COURSE_COMMAND_KEY_CONFLICT");
      return JSON.parse(prior.result_json) as CourseCommercialResult;
    }
    const rows = db.prepare(`SELECT p.product_ref,o.offer_ref FROM products p LEFT JOIN offers o ON o.product_id=p.id
      WHERE p.kind='ONLINE_COURSE' AND p.course_ref=?`).all(input.courseRef) as Array<{ product_ref: string; offer_ref: string | null }>;
    if (rows.length > 1) throw new Error("COURSE_PRODUCT_AMBIGUOUS");
    const refs = rows[0];
    const result: CourseCommercialResult = { ...configureProduct(db, config, {
      kind: "ONLINE_COURSE", courseRef: input.courseRef, productRef: refs?.product_ref ?? `course:${input.courseRef}`,
      offerRef: refs?.offer_ref ?? `course:${input.courseRef}`, accessModel: input.accessModel,
      priceKopecks: input.priceKopecks, saleMode: "CLOSED", actor: input.actor, expectedVersion: input.expectedVersion,
    }, now), accessModel: input.accessModel, priceKopecks: input.priceKopecks, saleMode: "CLOSED" };
    db.prepare(`INSERT INTO course_commercial_commands(actor,course_ref,command_key,request_sha256,result_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(input.actor, input.courseRef, input.commandKey, digest, JSON.stringify(result), now);
    return result;
  }).immediate();
}
