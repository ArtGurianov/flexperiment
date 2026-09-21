/**
 * The guards the launch baseline adds, proved against the baseline itself.
 *
 * Every other suite runs against the migration ledger. When the ledger is
 * deleted these objects would have no surviving test at all, and a baseline
 * that regressed - a dropped trigger, a widened CHECK, a partial index that
 * stopped being partial - would leave the main suite entirely green. So this
 * file builds a database from `0001_launch_baseline.sql` and asserts the
 * behaviour, not the text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

const BASELINE = join(__dirname, "..", "migrations", "0001_launch_baseline.sql");
const sql = readFileSync(BASELINE, "utf8");

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(sql);
  db.pragma("foreign_keys = ON");
});

/** Asserts the statement is refused, and by which guard. */
const refuses = (statement: string, code: string) => {
  expect(() => db.exec(statement)).toThrow(new RegExp(code));
};

const session = (id: string, over: Record<string, string | number | null> = {}) => {
  const row = {
    id, owner_id: "owner", mode: "MAINTENANCE_CUTOVER", target_sha: "a".repeat(40),
    candidate_id: "cand", state: "DEPLOYING", rollback_authority: "OLD_LINEAGE_ALLOWED",
    pre_deploy_topology: '{"frontend":"o","admin":"o","commerce":"o","worker":"o"}',
    created_at: "2026-01-01T00:00:00.000Z", lease_expires_at: "2026-01-01T00:05:00.000Z",
    ...over,
  };
  const keys = Object.keys(row);
  const literal = (key: string) => {
    const value = (row as Record<string, unknown>)[key];
    return value === null ? "NULL" : `'${String(value)}'`;
  };
  return `INSERT INTO deploy_sessions(${keys.join(",")}) VALUES (${keys.map(literal).join(",")})`;
};

describe("genesis", () => {
  it("makes the database identifiable before anything trusts it", () => {
    expect(db.prepare("SELECT lineage FROM schema_identity WHERE singleton = 1").get())
      .toEqual({ lineage: "flexperiment-launch" });
  });

  it("starts the feature active, because there is no state meaning 'before the feature'", () => {
    expect(db.prepare("SELECT state, revision FROM agent_referrals_feature_state").get())
      .toEqual({ state: "ACTIVE", revision: 1 });
    refuses("UPDATE agent_referrals_feature_state SET state = 'DORMANT' WHERE singleton = 1", "CHECK constraint failed");
  });

  it("creates the singletons whose absence a runtime reads as fail-closed", () => {
    for (const table of ["outbox_authority", "emergency_sales_gate", "unisender_event_dump_control"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    }
  });

  it("carries every advertising policy row the ORD path resolves against", () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy WHERE status = 'ALLOWED'").get()).toEqual({ n: 9 });
    // The basis genuinely differs per format; a uniform seed would be wrong.
    expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_period_policy WHERE reporting_basis = 'PROVIDER_SPECIAL_PERIOD'").get())
      .toEqual({ n: 3 });
  });
});

describe("deploy_sessions", () => {
  it("admits one live session and any number of finished ones", () => {
    db.exec(session("d1"));
    expect(() => db.exec(session("d2", { state: "ACQUIRED" }))).toThrow(/UNIQUE constraint failed/);
    db.exec(session("d3", { state: "SUCCEEDED" }));
    db.exec(session("d4", { state: "ROLLED_BACK" }));
  });

  it("cannot be created without the snapshot a safe abort is decided from", () => {
    expect(() => db.exec(
      `INSERT INTO deploy_sessions(id,owner_id,mode,target_sha,candidate_id,state,rollback_authority,created_at,lease_expires_at)
       VALUES ('d','o','MAINTENANCE_CUTOVER','sha','c','ACQUIRED','OLD_LINEAGE_ALLOWED','t','t')`))
      .toThrow(/NOT NULL constraint failed: deploy_sessions.pre_deploy_topology/);
  });

  it("refuses a finished session that still holds sales shut", () => {
    for (const state of ["SAFE_ABORTED", "SUCCEEDED", "ROLLED_BACK"]) {
      refuses(session("x", { state, deployment_gate_closed: 1 }), "CHECK constraint failed");
    }
  });

  it("refuses a rolling release that fences, and a safe abort after a mutation", () => {
    refuses(session("r", { mode: "ROLLING_SAFE", deployment_gate_closed: 1 }), "CHECK constraint failed");
    refuses(session("s", { state: "SAFE_ABORTED", mutation_observed: 1 }), "CHECK constraint failed");
  });

  it("refuses an ordinary session that cannot name what it deploys", () => {
    // A candidate may be absent only where there is genuinely none to name:
    // an adopted cutover crosses into a database whose candidate registry is
    // empty. Anywhere else, a nameless session is not a permitted state.
    refuses(session("nameless", { candidate_id: null }), "CHECK constraint failed");
    db.exec(session("adopted", {
      candidate_id: null, adopted_cutover_id: "c1", adopted_envelope_sha256: "e".repeat(64),
      predecessor_database_ref: "prelaunch.sqlite", predecessor_database_sha256: "f".repeat(64),
    }));
    // ...and the target stays identifiable either way.
    expect(db.prepare("SELECT target_sha FROM deploy_sessions WHERE id = 'adopted'").get())
      .toEqual({ target_sha: "a".repeat(40) });
  });

  it("refuses a half-adopted handoff in either direction", () => {
    refuses(session("a", { adopted_cutover_id: "c1" }), "CHECK constraint failed");
    refuses(session("b", { predecessor_database_sha256: "f".repeat(64) }), "CHECK constraint failed");
    db.exec(session("ok", {
      adopted_cutover_id: "c1", adopted_envelope_sha256: "e".repeat(64),
      predecessor_database_ref: "prelaunch.sqlite", predecessor_database_sha256: "f".repeat(64),
    }));
  });

  it("freezes the snapshot and the adoption evidence, and only those", () => {
    db.exec(session("d1", {
      adopted_cutover_id: "c1", adopted_envelope_sha256: "e".repeat(64),
      predecessor_database_ref: "prelaunch.sqlite", predecessor_database_sha256: "f".repeat(64),
    }));
    refuses("UPDATE deploy_sessions SET pre_deploy_topology = '{}' WHERE id = 'd1'", "DEPLOY_SESSION_IDENTITY_IMMUTABLE");
    refuses("UPDATE deploy_sessions SET predecessor_database_sha256 = NULL WHERE id = 'd1'", "DEPLOY_SESSION_IDENTITY_IMMUTABLE");
    refuses("UPDATE deploy_sessions SET adopted_cutover_id = 'c2' WHERE id = 'd1'", "DEPLOY_SESSION_IDENTITY_IMMUTABLE");
    // The reading is meant to be retaken, and retaken again.
    db.exec("UPDATE deploy_sessions SET observed_topology = '{\"commerce\":\"new\"}' WHERE id = 'd1'");
    db.exec("UPDATE deploy_sessions SET observed_topology = '{\"commerce\":\"newer\"}' WHERE id = 'd1'");
  });

  it("moves the monotonic bits one way only", () => {
    db.exec(session("d1", { mutation_observed: 1 }));
    refuses("UPDATE deploy_sessions SET mutation_observed = 0 WHERE id = 'd1'", "DEPLOY_SESSION_TRANSITION_ILLEGAL");
    db.exec("UPDATE deploy_sessions SET rollback_authority = 'NEW_LINEAGE_ONLY' WHERE id = 'd1'");
    refuses("UPDATE deploy_sessions SET rollback_authority = 'OLD_LINEAGE_ALLOWED' WHERE id = 'd1'", "DEPLOY_SESSION_TRANSITION_ILLEGAL");
  });

  it("lets nothing edit a session that already ended", () => {
    db.exec(session("d1", { state: "SUCCEEDED" }));
    refuses("UPDATE deploy_sessions SET owner_id = 'someone-else' WHERE id = 'd1'", "DEPLOY_SESSION_TRANSITION_ILLEGAL");
  });
});

describe("certification_capabilities", () => {
  const run = `INSERT INTO certification_runs(run_id,revision,release_sha,phase,direction,started_at)
    VALUES ('r1',1,'sha','NEW','NORMAL','2026-01-01T00:00:00.000Z')`;
  /** Expiry is a wall-clock fact here, so the fixtures straddle the real clock. */
  const EXPIRED = "2020-01-01T00:00:00.000Z";
  const LIVE = "2099-01-01T00:00:00.000Z";
  const capability = (id: string, nonce: string, expires: string) =>
    `INSERT INTO certification_capabilities(id,run_id,deployment_session_id,release_sha,max_amount_kopecks,expires_at,nonce)
     VALUES ('${id}','r1','d1','sha',100,'${expires}','${nonce}')`;

  beforeEach(() => { db.exec(session("d1")); db.exec(run); });

  it("holds the slot against a second live capability", () => {
    db.exec(capability("c1", "n1", LIVE));
    expect(() => db.exec(capability("c2", "n2", LIVE))).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses to retire a capability that has not expired yet", () => {
    db.exec(capability("c1", "n1", LIVE));
    refuses(`UPDATE certification_capabilities SET retired_at = '${new Date().toISOString()}' WHERE id = 'c1'`,
      "CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("cannot be freed early by stamping the retirement in the future", () => {
    // Comparing `retired_at` to `expires_at` alone would accept this: the
    // written value does read as later than expiry. What it is not is a
    // retirement that has happened, and the slot would be free today.
    db.exec(capability("c1", "n1", LIVE));
    refuses("UPDATE certification_capabilities SET retired_at = '9999-01-01T00:00:00.000Z' WHERE id = 'c1'",
      "CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    expect(() => db.exec(capability("c2", "n2", LIVE))).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a retirement stamped ahead of the database's own clock", () => {
    db.exec(capability("c1", "n1", EXPIRED));
    refuses("UPDATE certification_capabilities SET retired_at = '2099-06-01T00:00:00.000Z' WHERE id = 'c1'",
      "CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("refuses a retirement stamped before the expiry it claims to follow", () => {
    db.exec(capability("c1", "n1", EXPIRED));
    refuses("UPDATE certification_capabilities SET retired_at = '2019-01-01T00:00:00.000Z' WHERE id = 'c1'",
      "CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("allows reissue once the old one has really expired, and keeps the history", () => {
    db.exec(capability("c1", "n1", EXPIRED));
    db.exec(`UPDATE certification_capabilities SET retired_at = '${new Date().toISOString()}' WHERE id = 'c1'`);
    db.exec(capability("c2", "n2", LIVE));
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_capabilities").get()).toEqual({ n: 2 });
  });

  it("keeps spent and replaced as different endings, and both one-way", () => {
    db.exec(capability("c1", "n1", EXPIRED));
    db.exec("UPDATE certification_capabilities SET consumed_at = '2026-01-01T00:01:00.000Z' WHERE id = 'c1'");
    // Retiring what was already spent is refused by the guard before the CHECK
    // ever sees it; both say the same thing, and the guard says it first.
    refuses(`UPDATE certification_capabilities SET retired_at = '${new Date().toISOString()}' WHERE id = 'c1'`,
      "CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    refuses("UPDATE certification_capabilities SET consumed_at = '2026-01-01T00:02:00.000Z' WHERE id = 'c1'",
      "CERTIFICATION_CAPABILITY_ENDING_IMMUTABLE");
  });

  it("refuses to spend a capability that was replaced instead", () => {
    db.exec(capability("c1", "n1", EXPIRED));
    db.exec(`UPDATE certification_capabilities SET retired_at = '${new Date().toISOString()}' WHERE id = 'c1'`);
    // Only the CHECK stands here: the row was never consumed, so the one-way
    // guard has nothing to compare, and it is no longer being retired.
    refuses("UPDATE certification_capabilities SET consumed_at = '2026-01-01T00:11:00.000Z' WHERE id = 'c1'", "CHECK constraint failed");
  });

  it("refuses any edit to the scope it was issued within", () => {
    db.exec(capability("c1", "n1", LIVE));
    for (const column of ["release_sha = 'other'", "max_amount_kopecks = 999999", "expires_at = '2098-01-01T00:00:00.000Z'", "nonce = 'n9'"]) {
      refuses(`UPDATE certification_capabilities SET ${column} WHERE id = 'c1'`, "CERTIFICATION_CAPABILITY_SCOPE_IMMUTABLE");
    }
  });
});

describe("durable authority is never deleted", () => {
  // No store exposes a delete. Without these guards the slot model is bypassed
  // outright: remove the live capability and the partial index never gets a
  // say. A mutation sweep cannot find this class of defect - it asks whether an
  // existing guard is needed, not which guard was never written.
  it("refuses to delete a live deploy session", () => {
    db.exec(session("d1"));
    refuses("DELETE FROM deploy_sessions WHERE id = 'd1'", "DEPLOY_SESSION_IMMUTABLE");
  });

  it("refuses to delete a finished deploy session", () => {
    db.exec(session("d1", { state: "SUCCEEDED" }));
    refuses("DELETE FROM deploy_sessions WHERE id = 'd1'", "DEPLOY_SESSION_IMMUTABLE");
  });

  it("refuses to delete a run nothing references yet", () => {
    db.exec(`INSERT INTO certification_runs(run_id,revision,release_sha,phase,direction,started_at)
      VALUES ('r1',1,'sha','NEW','NORMAL','2026-01-01T00:00:00.000Z')`);
    // Nothing points at it, so a foreign key would not object. The guard must.
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_capabilities WHERE run_id = 'r1'").get()).toEqual({ n: 0 });
    refuses("DELETE FROM certification_runs WHERE run_id = 'r1'", "CERTIFICATION_RUN_IMMUTABLE");
  });

  it("refuses to delete a live capability, so the slot cannot be freed that way", () => {
    db.exec(session("d1"));
    db.exec(`INSERT INTO certification_runs(run_id,revision,release_sha,phase,direction,started_at)
      VALUES ('r1',1,'sha','NEW','NORMAL','2026-01-01T00:00:00.000Z')`);
    db.exec(`INSERT INTO certification_capabilities(id,run_id,deployment_session_id,release_sha,max_amount_kopecks,expires_at,nonce)
      VALUES ('c1','r1','d1','sha',100,'2099-01-01T00:00:00.000Z','n1')`);
    refuses("DELETE FROM certification_capabilities WHERE id = 'c1'", "CERTIFICATION_CAPABILITY_IMMUTABLE");
    expect(() => db.exec(`INSERT INTO certification_capabilities(id,run_id,deployment_session_id,release_sha,max_amount_kopecks,expires_at,nonce)
      VALUES ('c2','r1','d1','sha',100,'2099-01-01T00:00:00.000Z','n2')`)).toThrow(/UNIQUE constraint failed/);
  });

  it("guards every durable authority table, not only the ones remembered", () => {
    for (const table of ["deploy_sessions", "certification_runs", "certification_capabilities", "schema_identity"]) {
      const guards = db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql LIKE '%BEFORE DELETE%'").get(table);
      expect(guards, `${table} has no delete guard`).toEqual({ n: 1 });
    }
  });
});

describe("certification_runs", () => {
  beforeEach(() => db.exec(`INSERT INTO certification_runs(run_id,revision,release_sha,phase,direction,started_at)
    VALUES ('r1',1,'sha','PAYMENT_PROVEN','FINANCIAL_EFFECT_POSSIBLE','2026-01-01T00:00:00.000Z')`));

  it("advances the revision by exactly one", () => {
    refuses("UPDATE certification_runs SET revision = 3 WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    refuses("UPDATE certification_runs SET revision = 1 WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    db.exec("UPDATE certification_runs SET revision = 2 WHERE run_id = 'r1'");
  });

  it("never lets phase or cleanup direction move backwards", () => {
    refuses("UPDATE certification_runs SET revision = 2, phase = 'QUOTE_READY' WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    refuses("UPDATE certification_runs SET revision = 2, direction = 'NORMAL' WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    db.exec("UPDATE certification_runs SET revision = 2, phase = 'TICKET_EMAIL_DELIVERED', direction = 'CLEANUP_STARTED' WHERE run_id = 'r1'");
  });

  it("freezes the run's identity", () => {
    for (const column of ["release_sha = 'other'", "started_at = '2020-01-01T00:00:00.000Z'"]) {
      refuses(`UPDATE certification_runs SET revision = 2, ${column} WHERE run_id = 'r1'`, "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    }
  });

  it("refuses to replace one armed command with another", () => {
    db.exec("UPDATE certification_runs SET revision = 2, pending_command = '{\"kind\":\"CANCEL_BOOKING\"}' WHERE run_id = 'r1'");
    refuses("UPDATE certification_runs SET revision = 3, pending_command = '{\"kind\":\"CREATE_CHECKOUT\"}' WHERE run_id = 'r1'",
      "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    // Settling it is the adapter's own decision and stays legal.
    db.exec("UPDATE certification_runs SET revision = 3, pending_command = NULL WHERE run_id = 'r1'");
  });

  it("writes a superseded command once", () => {
    db.exec("UPDATE certification_runs SET revision = 2, superseded_command = '{\"reason\":\"CLEANUP_SUPERSEDED_CATALOGUE_OPENING\"}' WHERE run_id = 'r1'");
    refuses("UPDATE certification_runs SET revision = 3, superseded_command = NULL WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
  });

  it("never rewrites or clears a recorded failure", () => {
    db.exec(`UPDATE certification_runs SET revision = 2, failure_outcome = 'FAILED', failure_code = 'X', failure_recorded_at = '2026-01-01T00:01:00.000Z' WHERE run_id = 'r1'`);
    refuses("UPDATE certification_runs SET revision = 3, failure_outcome = NULL, failure_code = NULL, failure_recorded_at = NULL WHERE run_id = 'r1'",
      "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
    refuses("UPDATE certification_runs SET revision = 3, failure_code = 'Y' WHERE run_id = 'r1'", "CERTIFICATION_RUN_TRANSITION_ILLEGAL");
  });

  it("keeps a failure's three parts inseparable", () => {
    refuses("UPDATE certification_runs SET revision = 2, failure_outcome = 'FAILED' WHERE run_id = 'r1'", "CHECK constraint failed");
  });

  it("writes each recovery identifier once, because recovery follows them to real objects", () => {
    const evidence = ["occurrence_id", "quote_id", "status_id", "order_id", "payment_id", "booking_id",
      "ticket_id", "refund_obligation_id", "refund_id", "human_ticket_verified_at", "completed_at"];
    let revision = 1;
    for (const column of evidence) {
      revision += 1;
      db.exec(`UPDATE certification_runs SET revision = ${revision}, ${column} = 'first' WHERE run_id = 'r1'`);
      refuses(`UPDATE certification_runs SET revision = ${revision + 1}, ${column} = 'second' WHERE run_id = 'r1'`,
        "CERTIFICATION_RUN_EVIDENCE_IMMUTABLE");
      refuses(`UPDATE certification_runs SET revision = ${revision + 1}, ${column} = NULL WHERE run_id = 'r1'`,
        "CERTIFICATION_RUN_EVIDENCE_IMMUTABLE");
    }
  });
});

describe("the defects the baseline closes", () => {
  it("freezes the tax snapshot the settlement was prepared from", () => {
    // 0053 added these four and the tuple guard validated them on INSERT; 0058
    // reinstalled the immutability guard without them, so a PREPARED settlement
    // could have its canonical hash rewritten in place.
    db.exec("DROP TRIGGER reward_settlements_authority_tuple_consistency_guard");
    db.exec("DROP TRIGGER reward_settlements_contractor_type_projection_guard");
    db.pragma("foreign_keys = OFF");
    const required = (db.prepare("PRAGMA table_info(reward_settlements)").all() as { name: string; type: string; notnull: number; dflt_value: unknown }[])
      .filter((c) => c.notnull && c.dflt_value === null);
    const row: Record<string, string | number> = { id: "s1", status: "PREPARED", tax_canonical_hash: "original" };
    for (const c of required) if (!(c.name in row)) row[c.name] = c.type === "INTEGER" ? 1 : "x";
    const names = Object.keys(row);
    db.prepare(`INSERT INTO reward_settlements(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => row[n]));
    for (const column of ["tax_canonical_hash", "tax_canonical_json", "tax_canonicalization_version", "tax_treatment_revision_id_snapshot"]) {
      refuses(`UPDATE reward_settlements SET ${column} = 'rewritten' WHERE id = 's1'`, "REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE");
    }
  });

  it("leaves no column meaning 'this row predates a feature'", () => {
    // Named per table on purpose. `provider_idempotence_key` is retired from
    // `email_outbox` and is still `outbox_attempt`'s own key - a schema-wide
    // string search would call that a leftover and be wrong.
    const retired: Record<string, string[]> = {
      orders: ["reward_authority_kind", "order_purpose"],
      referral_rewards: ["reward_authority_kind"],
      reward_settlements: ["settlement_flow"],
      outbox_authority: ["attempt_authority", "dispatch_owner_release_id", "dispatch_owner_generation"],
      outbox_authority_events: ["owner_release_id", "owner_generation"],
      partners: ["default_reward_type", "default_reward_value"],
      email_outbox: ["provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
        "provider_request_started_at", "attempts", "last_error", "provider_error_code", "provider_error_message", "next_attempt_at"],
    };
    for (const [table, columns] of Object.entries(retired)) {
      const present = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      for (const column of columns) expect(present).not.toContain(column);
    }
    // The attempt record keeps the key that is genuinely its own.
    expect((db.prepare("PRAGMA table_info(outbox_attempt)").all() as { name: string }[]).map((c) => c.name))
      .toContain("provider_idempotence_key");
    // And no trigger condition may still name a discriminator.
    const triggers = db.prepare("SELECT group_concat(sql, ' ') AS all_sql FROM sqlite_master WHERE type = 'trigger'").get() as { all_sql: string };
    for (const gone of ["reward_authority_kind", "settlement_flow", "attempt_authority", "DORMANT"]) {
      expect(triggers.all_sql).not.toContain(gone);
    }
  });

  it("binds the only certification discriminator by foreign key", () => {
    const fks = db.prepare("PRAGMA foreign_key_list(orders)").all() as { from: string; table: string; to: string }[];
    expect(fks).toContainEqual(expect.objectContaining({ from: "certification_run_id", table: "certification_runs", to: "run_id" }));
    // No `order_purpose`: a second column with one meaningful value is a monument.
    expect(db.prepare("PRAGMA table_info(orders)").all()).not.toContainEqual(expect.objectContaining({ name: "order_purpose" }));
  });

  it("points the partner keys at a table called partners", () => {
    const referencing = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .flatMap((t) => (db.prepare(`PRAGMA foreign_key_list(${t.name})`).all() as { table: string }[]))
      .filter((f) => f.table === "partners");
    expect(referencing).toHaveLength(13);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agents'").get()).toBeUndefined();
  });
});
