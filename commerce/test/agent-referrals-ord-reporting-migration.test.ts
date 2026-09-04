import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0048 is the ORD/ERIR reporting authority schema (plan Phase 8): provider
 * profile/reporting-period-policy configuration, ord_creative_registrations,
 * ord_distribution_period_reports, ord_paid_invoice_payloads. Ordinary
 * migration - not FK-off, and it adds no 0049+.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0048_ord_reporting.sql";
const BEFORE_0048 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0048").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "ord-reporting-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0048) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0047 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "ord-reporting-migration-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);

describe("0048 ord_reporting migration", () => {
  it("applies cleanly on top of 0042-0047, FK stays ON, foreign_key_check is clean", () => {
    const db = at0047();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op (migrate() twice)", () => {
    const db = at0047();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    migrate(db);
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0047();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0049+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("introduces exactly six new tables, no levy/income-recognition/contribution/RKN/UIN table, no generic multi-provider abstraction table", () => {
    const db = at0047();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual([
      "ord_creative_registrations", "ord_distribution_period_reports", "ord_paid_invoice_payloads", "ord_provider_operations", "ord_provider_profile_revisions", "ord_reporting_period_policy",
    ]);
    const forbidden = /income_recognition_rules|advertising_income_snapshot|contribution_snapshot|levy_quarter|rkn_payment|_uin\b|levy_receipt|levy_debt|withholding_state|ord_provider\b$/i;
    for (const name of introduced) expect(name).not.toMatch(forbidden);
  });

  it("creates no password/social-login/team/RBAC/capacity/generic-accounting table", () => {
    const db = at0047();
    migrate(db);
    const names = tableNames(db);
    expect(names.some((n) => /password|social_login|team|membership|role|capacity_pilot|ledger|chart_of_accounts/i.test(n))).toBe(false);
  });

  describe("PR3-PR7's required-schema-object list now also proves PR8's authority/evidence objects", () => {
    const pr8Objects = [
      "ord_provider_profile_revisions", "ord_provider_profile_revisions_immutable_guard", "ord_provider_profile_revisions_delete_guard", "ord_provider_profile_revisions_lineage_guard",
      "ord_reporting_period_policy", "ord_reporting_period_policy_immutable_guard", "ord_reporting_period_policy_delete_guard",
      "ord_provider_operations", "ord_provider_operations_relational_consistency_guard", "ord_provider_operations_terminal_immutable_guard",
      "ord_provider_operations_correction_only_guard", "ord_provider_operations_authority_immutable_guard", "ord_provider_operations_observed_id_immutable_guard", "ord_provider_operations_delete_guard",
      "ord_creative_registrations", "ord_creative_registrations_relational_consistency_guard", "ord_creative_registrations_terminal_immutable_guard",
      "ord_creative_registrations_correction_only_guard", "ord_creative_registrations_authority_immutable_guard", "ord_creative_registrations_observed_ids_immutable_guard", "ord_creative_registrations_delete_guard",
      "ord_distribution_period_reports", "ord_distribution_period_reports_relational_consistency_guard", "ord_distribution_period_reports_immutable_guard", "ord_distribution_period_reports_delete_guard",
      "ord_paid_invoice_payloads", "ord_paid_invoice_payloads_relational_consistency_guard", "ord_paid_invoice_payloads_terminal_immutable_guard",
      "ord_paid_invoice_payloads_authority_immutable_guard", "ord_paid_invoice_payloads_observed_id_immutable_guard", "ord_paid_invoice_payloads_delete_guard",
    ];

    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every PR8 object, exhaustively, as the list's exact suffix", () => {
      for (const object of pr8Objects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      const pr3through7Objects = AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.length - pr8Objects.length;
      const suffix = [...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS].slice(pr3through7Objects);
      expect(suffix).toEqual(pr8Objects);
    });

    it("passes on a DB migrated through 0048", () => {
      const db = at0047();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0048 has not been applied yet (0047 only)", () => {
      const db = at0047();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
    });

    it("fails closed and names the object when a PR8 trigger is dropped", () => {
      const db = at0047();
      migrate(db);
      db.exec("DROP TRIGGER ord_creative_registrations_terminal_immutable_guard");
      try {
        assertAgentReferralsFoundationSchemaPresent(db);
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as Error).message).toContain("ord_creative_registrations_terminal_immutable_guard");
      }
    });
  });
});

describe("ord_provider_profile_revisions: immutable configuration, no suspension gate", () => {
  it("is immutable and delete-protected", () => {
    const db = at0047(); migrate(db);
    db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, reason, created_by_admin_id) VALUES ('p1', 'COUNTERPARTY', 1, '{}', 'h', 'seed', 'admin')`).run();
    expect(() => db.prepare("UPDATE ord_provider_profile_revisions SET content_json = '{\"x\":1}' WHERE id = 'p1'").run()).toThrow(/ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM ord_provider_profile_revisions WHERE id = 'p1'").run()).toThrow(/ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE/);
  });

  it("UNIQUE(profile_kind, revision) refuses a duplicate revision number for the same kind", () => {
    const db = at0047(); migrate(db);
    db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, reason, created_by_admin_id) VALUES ('p1', 'COUNTERPARTY', 1, '{}', 'h1', 'seed', 'admin')`).run();
    expect(() => db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, reason, created_by_admin_id) VALUES ('p2', 'COUNTERPARTY', 1, '{}', 'h2', 'dup', 'admin')`).run())
      .toThrow(/UNIQUE constraint failed/);
  });
});

describe("ord_reporting_period_policy: seeded configuration", () => {
  it("seeds all ten format_kind values, ordinary formats CALENDAR_MONTH, authored/persistent formats PROVIDER_SPECIAL_PERIOD", () => {
    const db = at0047(); migrate(db);
    const rows = db.prepare("SELECT format_kind, reporting_basis FROM ord_reporting_period_policy").all() as { format_kind: string; reporting_basis: string }[];
    expect(rows).toHaveLength(10);
    const byKind = Object.fromEntries(rows.map((r) => [r.format_kind, r.reporting_basis]));
    for (const k of ["post", "story", "short_video", "audio", "text", "graphic", "text_graphic"]) expect(byKind[k]).toBe("CALENDAR_MONTH");
    for (const k of ["long_video", "stream", "native_authored"]) expect(byKind[k]).toBe("PROVIDER_SPECIAL_PERIOD");
  });

  it("is immutable and delete-protected", () => {
    const db = at0047(); migrate(db);
    const row = db.prepare("SELECT id FROM ord_reporting_period_policy WHERE format_kind = 'post'").get() as { id: string };
    expect(() => db.prepare("UPDATE ord_reporting_period_policy SET reporting_basis = 'PROVIDER_SPECIAL_PERIOD' WHERE id = ?").run(row.id)).toThrow(/ORD_REPORTING_PERIOD_POLICY_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM ord_reporting_period_policy WHERE id = ?").run(row.id)).toThrow(/ORD_REPORTING_PERIOD_POLICY_IMMUTABLE/);
  });
});

describe("network-absence boundary proof: no provider network client anywhere in PR8's own runtime modules", () => {
  const pr8Modules = [
    "agent-referrals-ord-operation-key.ts", "agent-referrals-ord-provider-profile.ts", "agent-referrals-ord-provider-operation.ts", "agent-referrals-ord-creative-registration.ts",
    "agent-referrals-ord-reporting.ts", "agent-referrals-ord-paid-invoice.ts",
  ];
  const bannedPatterns = [/\bfetch\s*\(/, /\baxios\b/, /\bhttps?\.request\b/, /\bXMLHttpRequest\b/, /\bnode-fetch\b/, /\bundici\b/, /\bwebsocket\b/i, /\bWebSocket\b/, /VK_API_/, /VK_PRODUCTION/];

  it("contains no network-client import, fetch call, or VK production credential reference", () => {
    for (const moduleName of pr8Modules) {
      const source = readFileSync(join(process.cwd(), "commerce", "src", moduleName), "utf8");
      for (const pattern of bannedPatterns) {
        expect(source, `${moduleName} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("no PR8 module imports node:http, node:https, or a fetch-polyfill package", () => {
    for (const moduleName of pr8Modules) {
      const source = readFileSync(join(process.cwd(), "commerce", "src", moduleName), "utf8");
      expect(source).not.toMatch(/from ["']node:https?["']/);
      expect(source).not.toMatch(/require\(["']https?["']\)/);
    }
  });
});

describe("levy-absence boundary proof: no resurrected internal levy subsystem", () => {
  it("the 0048 migration's actual SQL statements (comments stripped) create none of the banned levy identifiers", () => {
    // Comments legitimately NAME these banned concepts to document their
    // deliberate absence (matching this repo's own convention elsewhere) -
    // stripping "-- " line comments before scanning is what makes this a
    // check on the SCHEMA itself, not on prose that explains the schema.
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8")
      .split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
    const banned = [
      "income_recognition_rules", "advertising_income_snapshot", "contribution_snapshot", "levy_quarter", "LEVY_ESTIMATE_UNAVAILABLE",
      "rkn_payment_reconciliation", "partner_levy_receipt", "levy_debt", "withholding_state", "MATCH_MISMATCH", "LEVY_PAYER_CLASSIFICATION_UNCONFIRMED",
    ];
    for (const token of banned) expect(sql).not.toContain(token);
  });

  it("no PR8 source module contains a banned levy identifier", () => {
    const pr8Modules = [
      "agent-referrals-ord-operation-key.ts", "agent-referrals-ord-provider-profile.ts", "agent-referrals-ord-provider-operation.ts", "agent-referrals-ord-creative-registration.ts",
      "agent-referrals-ord-reporting.ts", "agent-referrals-ord-paid-invoice.ts",
    ];
    const banned = ["income_recognition_rules", "advertising_income_snapshot", "contribution_snapshot", "levy_quarter", "LEVY_ESTIMATE_UNAVAILABLE", "rkn_payment_reconciliation", "partner_levy_receipt", "levy_debt", "withholding_state"];
    for (const moduleName of pr8Modules) {
      const source = readFileSync(join(process.cwd(), "commerce", "src", moduleName), "utf8");
      for (const token of banned) expect(source).not.toContain(token);
    }
  });

  it("LEVY_PAYER_CLASSIFICATION_UNCONFIRMED, if present anywhere, remains only the one-time external activation gate - never a runtime calculation", () => {
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(sql).not.toContain("LEVY_PAYER_CLASSIFICATION_UNCONFIRMED");
  });
});
