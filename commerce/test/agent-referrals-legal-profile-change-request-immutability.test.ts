import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { admin, fresh, readyPartner } from "./support/agent-referrals-settlement-fixtures";
import {
  submitLegalProfileSupersession, currentLegalProfileRevisionForPartner, legalProfileChangeRequestHeadForPartner,
} from "../src/agent-referrals-legal-profile-supersession";

/**
 * Review round 3, P1: 0056 recreated this table's request-fields
 * immutability guard and restored 0051's ORIGINAL column list, silently
 * dropping the seven requisite columns 0052 had already added to it.
 *
 * The other two guards do not cover the gap. They block
 * PENDING -> PENDING and any update to an already-terminal row, but a
 * resolution is PENDING -> VERIFIED/REJECTED/STALE, which both ignore by
 * design. So during the one UPDATE this table legitimately accepts, the
 * request-fields guard is the ONLY thing standing between a resolution and a
 * rewrite of the evidence being resolved - a statement that terminalizes a
 * request and changes the INN it was filed with, in one go.
 *
 * Nothing in the replay or UI suites could see this: they exercise the
 * domain commands, which never attempt such an update. It is a structural
 * property and needs a structural test, which is what this file is.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/**
 * The RESOLUTION group: the columns a legitimate PENDING -> terminal update
 * is allowed to write. Everything else in the table is the "заявка" group -
 * what was filed - and is immutable from INSERT. Derived from the table
 * itself below, so a future column added to the request group cannot join it
 * without joining the guard too.
 *
 * `id` is deliberately NOT here, and the first version of this file had it
 * wrong. The row's identity is the first thing the evidence asserts, not a
 * resolution field, and a TEXT PRIMARY KEY is not an immutable one - SQLite
 * permits updating a PK whose new value does not collide. Listing it as a
 * resolution column made this very test carve out the hole it exists to
 * close.
 */
const RESOLUTION_COLUMNS = new Set([
  "state", "resolved_legal_profile_revision_id", "resolved_at", "resolved_by", "resolution_reason",
]);

const pendingRequest = (db: Database.Database) => {
  const p1 = readyPartner(db);
  const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, {
    legalForm: "LEGAL_ENTITY", taxMode: "OTHER",
    opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789",
    registration_number: "1234567890123", legal_address: "Moscow",
    reason: "became org", evidenceRef: "egrul.pdf",
    expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId),
    expectedRequestSequence: legalProfileChangeRequestHeadForPartner(db, p1.partnerIdentityId),
  });
  return { p1, request };
};

describe("legal-profile change requests: filed evidence is immutable through its own resolution", () => {
  // The columns whose rewrite would be most damaging and least visible -
  // every requisite 0052 added, the provenance 0051 already had, the counter
  // 0056 adds, and the row's own identity. This table is deliberately NOT
  // exhaustive over the request group (partner_identity_id,
  // supersedes_revision_id and created_at are absent): the structural test
  // below covers the whole group mechanically, and duplicating it by hand
  // here would only be a second list to forget to update.
  const MUTATIONS: Array<[string, unknown]> = [
    ["id", randomUUID()],
    ["opf", "AO"],
    ["full_name", "Someone Else LLC"],
    ["short_name", "SE"],
    ["inn", "9999999999"],
    ["kpp", "999999999"],
    ["registration_number", "9999999999999"],
    ["legal_address", "Novosibirsk"],
    ["legal_form", "INDIVIDUAL_ENTREPRENEUR"],
    ["tax_mode", "NPD"],
    ["assertion_source", "PARTNER_ASSERTED"],
    ["evidence_ref", "forged.pdf"],
    ["reason", "rewritten reason"],
    ["created_by", "someone-else"],
    ["request_sequence", 99],
  ];

  it.each(MUTATIONS)("refuses a resolution that also rewrites %s", (column, value) => {
    const { db } = fresh();
    open.push(db);
    const { request } = pendingRequest(db);

    // A legitimate resolution tuple - the transition itself is legal, which
    // is the whole point: the refusal must come from the field change, not
    // from the state change.
    expect(() => db.prepare(
      `UPDATE agent_referrals_legal_profile_change_requests
         SET state = 'REJECTED', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin-1', resolution_reason = 'rejected',
             ${column} = ?
       WHERE id = ?`,
    ).run(value, request.id)).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE/);

    // And nothing landed: the refusal is not a partial write.
    const after = db.prepare("SELECT state, inn, full_name FROM agent_referrals_legal_profile_change_requests WHERE id = ?").get(request.id) as { state: string; inn: string; full_name: string };
    expect(after).toEqual({ state: "PENDING", inn: "1234567890", full_name: "Romashka LLC" });
  });

  it("still allows the resolution itself - the guard refuses rewrites, not transitions", () => {
    const { db } = fresh();
    open.push(db);
    const { request } = pendingRequest(db);

    expect(() => db.prepare(
      `UPDATE agent_referrals_legal_profile_change_requests
         SET state = 'REJECTED', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin-1', resolution_reason = 'rejected'
       WHERE id = ?`,
    ).run(request.id)).not.toThrow();
    expect((db.prepare("SELECT state FROM agent_referrals_legal_profile_change_requests WHERE id = ?").get(request.id) as { state: string }).state).toBe("REJECTED");
  });

  /**
   * The test that would have caught 0056's own defect, and that catches the
   * next one: it reads the LIVE trigger out of sqlite_master and the LIVE
   * column list out of the table, and requires every request-group column to
   * be named in the guard. A DROP + CREATE that restates a stale definition
   * fails here even if it is textually self-consistent.
   */
  it("the live guard names every request-group column, whichever migration last recreated it", () => {
    const { db } = fresh();
    open.push(db);

    const guard = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get("agent_referrals_legal_profile_change_requests_request_fields_immutable_guard") as { sql: string }).sql;
    const columns = (db.prepare("SELECT name FROM pragma_table_info('agent_referrals_legal_profile_change_requests')")
      .all() as { name: string }[]).map((row) => row.name);

    const requestGroup = columns.filter((name) => !RESOLUTION_COLUMNS.has(name));
    expect(requestGroup.length).toBeGreaterThan(10);
    const unguarded = requestGroup.filter((name) => !new RegExp(`NEW\\.${name}\\b`).test(guard));
    expect(unguarded, "every filed-evidence column must be inside the immutability guard").toEqual([]);
  });
});
