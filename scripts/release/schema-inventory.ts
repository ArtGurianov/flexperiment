/**
 * The review artifact for the launch baseline.
 *
 * `.schema | sort` is not good enough to review a hand-assembled baseline
 * against the ledger it replaces: a lost partial unique index or a trigger
 * whose condition quietly changed is one line among thousands of DDL, and the
 * reviewer has to already suspect it to find it. This prints the schema as
 * objects grouped by the table they belong to, in a stable order, so a missing
 * constraint is its own line in a diff.
 *
 * Usage:
 *   tsx scripts/release/schema-inventory.ts ledger   # from every migration
 *   tsx scripts/release/schema-inventory.ts <file>   # from one SQL file
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const source = process.argv[2] ?? "ledger";
const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");

const migrations = join(process.cwd(), "commerce", "migrations");
if (source === "ledger") {
  for (const name of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(migrations, name), "utf8"));
} else {
  db.exec(readFileSync(source, "utf8"));
}

/** Comments and layout are not the contract; the statement is. */
const normalise = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

type Row = { name: string; sql: string | null; tbl_name: string; type: string };
const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Row[];
const tables = objects.filter((o) => o.type === "table").map((o) => o.name).sort();
const out: string[] = [];

for (const table of tables) {
  out.push(`TABLE ${table}`);
  for (const c of db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }[]) {
    const flags = [c.notnull ? "NOT NULL" : "", c.pk ? `PK(${c.pk})` : "", c.hidden ? `HIDDEN(${c.hidden})` : "", c.dflt_value === null ? "" : `DEFAULT ${normalise(c.dflt_value)}`].filter(Boolean);
    out.push(`  column ${c.name} ${c.type || "ANY"}${flags.length ? " " + flags.join(" ") : ""}`);
  }
  for (const f of (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { from: string; table: string; to: string | null; on_update: string; on_delete: string }[])
    .sort((a, b) => `${a.from}${a.table}`.localeCompare(`${b.from}${b.table}`))) {
    out.push(`  fk ${f.from} -> ${f.table}.${f.to ?? "rowid"} on_update=${f.on_update} on_delete=${f.on_delete}`);
  }
  for (const i of (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number; partial: number; origin: string }[])
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const columns = (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string | null }[]).map((c) => c.name ?? "<expr>").join(", ");
    const definition = objects.find((o) => o.type === "index" && o.name === i.name)?.sql;
    out.push(`  index ${i.name} unique=${i.unique} partial=${i.partial} origin=${i.origin} (${columns})`);
    if (i.partial && definition) out.push(`    predicate ${normalise(definition).replace(/^.*\bWHERE\b/i, "WHERE")}`);
  }
  for (const t of objects.filter((o) => o.type === "trigger" && o.tbl_name === table).sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`  trigger ${t.name}`);
    out.push(`    ${normalise(t.sql ?? "")}`);
  }
  out.push("");
}

const counts = objects.reduce<Record<string, number>>((all, o) => ({ ...all, [o.type]: (all[o.type] ?? 0) + 1 }), {});
out.push(`TOTALS ${Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(" ")}`);
process.stdout.write(out.join("\n") + "\n");
