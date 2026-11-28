import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { parseDocument } from "yaml";
import { z } from "zod";

const description = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const keysAt = (value: object) => Object.keys(value).sort();
const purpose = z.object({
  use: description,
  basis: description,
  retention: description,
  expiry: description,
  review: identifier.optional(),
}).strict();
const columnGroup = z.discriminatedUnion("classification", [
  z.object({ classification: z.literal("non_personal"), columns: z.array(identifier).min(1), reason: description }).strict(),
  z.object({
    classification: z.enum(["personal", "mixed", "secret"]),
    columns: z.array(identifier).min(1),
    subject: description,
    purposes: z.array(identifier).min(1),
    access: z.enum(["value", "projection", "description", "review"]),
    closure: z.enum(["destroy_when_due", "retain_minimum", "review"]),
    review: identifier.optional(),
  }).strict(),
]);
const registrySchema = z.object({
  version: z.literal(1),
  purposes: z.record(identifier, purpose),
  sqlite: z.record(identifier, z.array(columnGroup).min(1)),
  payloads: z.record(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/), z.object({
    content: description,
    review: identifier,
  }).strict()),
  stores: z.record(identifier, z.object({
    scope: z.enum(["source", "planned"]),
    location: description,
    subject: description,
    purposes: z.array(identifier).min(1),
    lifecycle: description,
    review: identifier,
  }).strict()),
  gaps: z.record(identifier, z.object({ issue: z.string().regex(/^(FLEX|VPS)-[1-9][0-9]*$/), evidence: description }).strict()),
}).strict();

export const registryPath = resolve(__dirname, "../../docs/legal/personal-data/registry.yaml");
export const generatedPath = resolve(__dirname, "../../docs/legal/personal-data/REGISTRY.md");
type Registry = z.infer<typeof registrySchema>;

export function readRegistry(source = readFileSync(registryPath, "utf8")) {
  // Inspect duplicate-key diagnostics before conversion. No YAML aliases, merge keys or duplicate declarations.
  const parsed = parseDocument(source, { uniqueKeys: true, merge: false });
  if (parsed.errors.length || parsed.warnings.length) {
    throw new Error(`DATA_REGISTRY_YAML: ${[...parsed.errors, ...parsed.warnings].map(error => error.message).join("; ")}`);
  }
  const registry = registrySchema.parse(parsed.toJS({ maxAliasCount: 0 }));
  assertReferences(registry);
  return { registry, digest: createHash("sha256").update(source).digest("hex") };
}

function assertReferences(registry: Registry) {
  const requireGap = (review: string | undefined, location: string) => {
    if (review !== undefined && !Object.hasOwn(registry.gaps, review)) {
      throw new Error(`DATA_REGISTRY_UNKNOWN_GAP: ${location} → ${review}`);
    }
  };
  const requirePurposes = (ids: string[], location: string) => {
    if (ids.length !== new Set(ids).size) throw new Error(`DATA_REGISTRY_DUPLICATE_PURPOSE: ${location}`);
    for (const id of ids) {
      if (!Object.hasOwn(registry.purposes, id)) throw new Error(`DATA_REGISTRY_UNKNOWN_PURPOSE: ${location} → ${id}`);
    }
  };
  for (const [id, policy] of Object.entries(registry.purposes)) requireGap(policy.review, id);
  for (const [table, groups] of Object.entries(registry.sqlite)) {
    const seen = new Set<string>();
    for (const group of groups) {
      for (const column of group.columns) {
        if (seen.has(column)) throw new Error(`DATA_REGISTRY_DUPLICATE_COLUMN: ${table}.${column}`);
        seen.add(column);
      }
      if (group.classification === "non_personal") continue;
      const location = `${table}.${group.columns.join(",")}`;
      requirePurposes(group.purposes, location);
      requireGap(group.review, location);
      if (group.access === "value" && group.classification !== "personal") {
        throw new Error(`DATA_REGISTRY_UNSAFE_VALUE_EXPORT: ${location}`);
      }
    }
  }
  for (const [location, payload] of Object.entries(registry.payloads)) {
    const [table, column] = location.split(".");
    const group = registry.sqlite[table]?.find(item => item.columns.includes(column));
    if (!group || group.classification === "non_personal" || group.access === "value") {
      throw new Error(`DATA_REGISTRY_UNSAFE_PAYLOAD: ${location}`);
    }
    requireGap(payload.review, location);
  }
  for (const [id, store] of Object.entries(registry.stores)) {
    requirePurposes(store.purposes, id);
    requireGap(store.review, id);
  }
}

export function assertSchemaCoverage(db: Database.Database, registry: Registry) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as Array<{ name: string }>;
  const columns = db.prepare("SELECT name FROM pragma_table_xinfo(?) ORDER BY name");
  const actual = new Map(tables.map(({ name }) => [name, new Set((columns.all(name) as Array<{ name: string }>).map(row => row.name))]));
  const errors: string[] = [];
  for (const [table, groups] of Object.entries(registry.sqlite)) {
    // Remove covered columns so leftovers identify every omitted column, including in entirely new tables.
    const remaining = actual.get(table);
    for (const column of groups.flatMap(group => group.columns)) {
      if (!remaining?.delete(column)) errors.push(`DATA_REGISTRY_STALE_COLUMN: ${table}.${column}`);
    }
  }
  for (const [table, remaining] of actual) {
    for (const column of remaining) errors.push(`DATA_REGISTRY_UNCLASSIFIED_COLUMN: ${table}.${column}`);
  }
  if (errors.length) throw new Error(errors.sort().join("\n"));
}

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s*\r?\n\s*/g, " ");
const row = (...values: string[]) => "| " + values.map(cell).join(" | ") + " |";

export function renderRegistry({ registry, digest }: ReturnType<typeof readRegistry>) {
  const out = [
    "# Реестр жизненного цикла данных Flexperiment",
    "",
    "Сгенерировано из [registry.yaml](registry.yaml). Порядок и границы применения см. в [ADR](../../architecture/personal-data-lifecycle.md).",
    "",
    `Версия формата ${registry.version}. SHA-256 исходного YAML \`${digest}\`.`,
    "",
    "## Цели и основания",
    "",
    row("Цель", "Назначение", "Основание", "Срок или событие окончания", "Действие по окончании", "Разрыв"),
    row("---", "---", "---", "---", "---", "---"),
  ];
  for (const id of keysAt(registry.purposes)) {
    const p = registry.purposes[id];
    out.push(row(id, p.use, p.basis, p.retention, p.expiry, p.review ?? "—"));
  }
  out.push("", "## Колонки SQLite Commerce V2", "",
    row("Таблица", "Колонки", "Класс", "Принадлежность или обоснование", "Цели", "Выдача", "Закрытие", "Разрыв"),
    row("---", "---", "---", "---", "---", "---", "---", "---"));
  for (const table of keysAt(registry.sqlite)) {
    for (const group of registry.sqlite[table]) {
      const fields = group.columns.map(name => `\`${name}\``).join(", ");
      if (group.classification === "non_personal") {
        out.push(row(table, fields, group.classification, group.reason, "—", "—", "—", "—"));
      } else {
        out.push(row(table, fields, group.classification, group.subject, group.purposes.join(", "), group.access, group.closure, group.review ?? "—"));
      }
    }
  }
  out.push("", "## Составные записи", "", row("Поле", "Охват", "Разрыв"), row("---", "---", "---"));
  for (const id of keysAt(registry.payloads)) {
    const p = registry.payloads[id];
    out.push(row(id, p.content, p.review));
  }
  out.push("", "## Хранилища и потоки вне основной SQLite", "",
    row("Группа", "Статус", "Место", "Принадлежность", "Цели", "Жизненный цикл", "Разрыв"),
    row("---", "---", "---", "---", "---", "---", "---"));
  for (const id of keysAt(registry.stores)) {
    const s = registry.stores[id];
    out.push(row(id, s.scope, s.location, s.subject, s.purposes.join(", "), s.lifecycle, s.review));
  }
  out.push("", "## Открытые разрывы и квалификация", "", row("ID", "Plane", "Что подтвердить"), row("---", "---", "---"));
  for (const id of keysAt(registry.gaps)) {
    const { issue, evidence } = registry.gaps[id];
    out.push(row(id, `[${issue}](https://app.plane.so/art-workspace/browse/${issue})`, evidence));
  }
  return out.join("\n") + "\n";
}
