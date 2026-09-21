/**
 * The difference between two schema inventories, as objects rather than lines.
 *
 * A textual diff of the inventory is not enough on its own: identical column
 * lines appear under many tables, so a reader cannot tell from a `<` line which
 * table lost something. This reads both sides into (table, object) pairs and
 * reports what each table gained and lost, which is the form an allowlist of
 * intended deltas can actually be checked against.
 *
 * Usage: tsx scripts/release/schema-delta.ts <before.txt> <after.txt>
 */
import { readFileSync } from "node:fs";

const parse = (path: string) => {
  const byTable = new Map<string, Set<string>>();
  let table = "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("TABLE ")) { table = line.slice(6).trim(); byTable.set(table, new Set()); continue; }
    if (line.startsWith("  ") && table) byTable.get(table)!.add(line.trim());
  }
  return byTable;
};

const before = parse(process.argv[2]);
const after = parse(process.argv[3]);
const tables = [...new Set([...before.keys(), ...after.keys()])].sort();
let removedTables = 0, addedTables = 0, removed = 0, added = 0;

for (const table of tables) {
  const from = before.get(table);
  const to = after.get(table);
  if (from && !to) { console.log(`- TABLE ${table}  (${from.size} objects)`); removedTables += 1; continue; }
  if (!from && to) { console.log(`+ TABLE ${table}  (${to.size} objects)`); addedTables += 1; continue; }
  const gone = [...from!].filter((o) => !to!.has(o));
  const fresh = [...to!].filter((o) => !from!.has(o));
  if (!gone.length && !fresh.length) continue;
  console.log(`~ TABLE ${table}`);
  for (const o of gone.sort()) { console.log(`    - ${o}`); removed += 1; }
  for (const o of fresh.sort()) { console.log(`    + ${o}`); added += 1; }
}
console.log(`\nSUMMARY tables -${removedTables} +${addedTables}; objects -${removed} +${added}`);
