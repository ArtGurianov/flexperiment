import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { parseDocument } from "yaml";
import { z } from "zod";

const description = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const keysAt = (value: object) => Object.keys(value).sort();
const access = z.enum(["value", "projection", "description", "review"]);
const closure = z.enum(["destroy_when_due", "retain_minimum", "review"]);
const retentionPolicy = z.enum(["EXPIRED_CREDENTIALS", "AUTH_OUTBOX", "UNBOUND_INTENTS", "PLAYBACK_TELEMETRY", "BACKUP_ARCHIVES"]);
const purpose = z.object({
  use: description,
  basis: description,
  retention: description,
  expiry: description,
  sources: z.array(identifier).min(1),
  review: identifier.optional(),
}).strict();
const columnGroup = z.discriminatedUnion("classification", [
  z.object({ classification: z.literal("non_personal"), columns: z.array(identifier).min(1), reason: description }).strict(),
  z.object({
    classification: z.enum(["personal", "mixed", "secret"]),
    columns: z.array(identifier).min(1),
    subject: description,
    purposes: z.array(identifier).min(1),
    access,
    closure,
    payloadColumns: z.array(identifier).min(1).optional(),
    retentionPolicies: z.array(retentionPolicy).min(1).optional(),
    observed: z.object({
      status: z.enum(["matches", "conditional", "gap"]),
      behavior: description,
      sources: z.array(identifier).min(1),
    }).strict().optional(),
    review: identifier.optional(),
  }).strict(),
]);
const registrySchema = z.object({
  version: z.literal(1),
  sources: z.record(identifier, z.object({
    kind: z.enum(["law", "owner", "source", "test", "contract", "inventory"]),
    ref: description,
  }).strict()),
  retentionPolicies: z.record(retentionPolicy, z.object({
    parameter: description,
    scope: description,
    source: identifier,
    review: identifier,
  }).strict()),
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
    access: access.exclude(["value"]),
    closure,
    retentionPolicies: z.array(retentionPolicy).min(1).optional(),
    sources: z.array(identifier).min(1),
    lifecycle: description,
    review: identifier,
  }).strict()),
  gaps: z.record(identifier, z.object({ issue: z.string().regex(/^(FLEX|VPS)-[1-9][0-9]*$/), evidence: description }).strict()),
}).strict();

export const registryPath = resolve(__dirname, "../../docs/legal/personal-data/registry.yaml");
export const generatedPath = resolve(__dirname, "../../docs/legal/personal-data/REGISTRY.md");
type Registry = z.infer<typeof registrySchema>;
type ColumnGroup = z.infer<typeof columnGroup>;

// These fields have independently reviewed semantics. Changing a YAML label
// must not make a credential exportable or move known identifiers out of scope.
const protectedColumns: Record<string, ColumnGroup["classification"]> = {
  "session.token": "secret",
  "verification.value": "secret",
  "account.password": "secret",
  "control_room_totp.seed_ciphertext": "secret",
  "lab_tickets.qr_sha256": "secret",
  "customers.email_normalized": "personal",
  "offers.acceptance_allowlist_json": "mixed",
};

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
  const requireSources = (ids: string[], location: string) => {
    for (const id of ids) {
      if (!Object.hasOwn(registry.sources, id)) throw new Error(`DATA_REGISTRY_UNKNOWN_SOURCE: ${location} → ${id}`);
    }
  };
  for (const [id, policy] of Object.entries(registry.purposes)) {
    requireGap(policy.review, id);
    requireSources(policy.sources, id);
  }
  for (const [id, policy] of Object.entries(registry.retentionPolicies)) {
    requireSources([policy.source], id);
    requireGap(policy.review, id);
  }
  const columns = new Map<string, ColumnGroup>();
  for (const [table, groups] of Object.entries(registry.sqlite)) {
    for (const group of groups) {
      for (const column of group.columns) {
        const key = `${table}.${column}`;
        if (columns.has(key)) throw new Error(`DATA_REGISTRY_DUPLICATE_COLUMN: ${key}`);
        columns.set(key, group);
      }
      if (group.classification === "non_personal") continue;
      const location = `${table}.${group.columns.join(",")}`;
      requirePurposes(group.purposes, location);
      requireGap(group.review, location);
      if (group.access === "value" && group.classification !== "personal") {
        throw new Error(`DATA_REGISTRY_UNSAFE_VALUE_EXPORT: ${location}`);
      }
      if (group.classification === "secret" && group.access === "projection") {
        throw new Error(`DATA_REGISTRY_UNSAFE_SECRET_PROJECTION: ${location}`);
      }
      if (group.observed) requireSources(group.observed.sources, location);
      for (const column of group.payloadColumns ?? []) {
        if (!group.columns.includes(column)) throw new Error(`DATA_REGISTRY_UNBOUND_PAYLOAD: ${table}.${column}`);
      }
    }
  }
  for (const [location, classification] of Object.entries(protectedColumns)) {
    if (columns.get(location)?.classification !== classification) {
      throw new Error(`DATA_REGISTRY_PROTECTED_CLASSIFICATION: ${location}`);
    }
  }
  const needsPayload = (location: string, group: ColumnGroup) => location.endsWith("_json") ||
    (group.classification !== "non_personal" && group.payloadColumns?.includes(location.split(".")[1]) === true);
  for (const [location, group] of columns) {
    if (needsPayload(location, group) && !Object.hasOwn(registry.payloads, location)) {
      throw new Error(`DATA_REGISTRY_MISSING_PAYLOAD: ${location}`);
    }
  }
  for (const [location, payload] of Object.entries(registry.payloads)) {
    const group = columns.get(location);
    if (!group || !needsPayload(location, group) || (group.classification !== "non_personal" && group.access === "value")) {
      throw new Error(`DATA_REGISTRY_UNSAFE_PAYLOAD: ${location}`);
    }
    requireGap(payload.review, location);
  }
  for (const [id, store] of Object.entries(registry.stores)) {
    requirePurposes(store.purposes, id);
    requireGap(store.review, id);
    requireSources(store.sources, id);
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
    row("Цель", "Назначение", "Основание", "Срок или событие окончания", "Действие по окончании", "Источники", "Разрыв"),
    row("---", "---", "---", "---", "---", "---", "---"),
  ];
  for (const id of keysAt(registry.purposes)) {
    const p = registry.purposes[id];
    out.push(row(id, p.use, p.basis, p.retention, p.expiry, p.sources.join(", "), p.review ?? "—"));
  }
  out.push("", "## Колонки SQLite Commerce V2", "",
    row("Таблица", "Колонки", "Класс", "Принадлежность или обоснование", "Цели", "Выдача", "Целевое закрытие", "Retention в исходниках", "Наблюдение и источник", "Разрыв"),
    row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---"));
  for (const table of keysAt(registry.sqlite)) {
    for (const group of registry.sqlite[table]) {
      const fields = group.columns.map(name => `\`${name}\``).join(", ");
      if (group.classification === "non_personal") {
        out.push(row(table, fields, group.classification, group.reason, "—", "—", "—", "—", "—", "—"));
      } else {
        const observed = group.observed;
        out.push(row(table, fields, group.classification, group.subject, group.purposes.join(", "),
          group.access, group.closure, group.retentionPolicies?.join(", ") ?? "—",
          observed ? `${observed.status} · ${observed.behavior} (${observed.sources.join(", ")})` : "—",
          group.review ?? "—"));
      }
    }
  }
  out.push("", "## Составные записи", "", row("Поле", "Охват", "Разрыв"), row("---", "---", "---"));
  for (const id of keysAt(registry.payloads)) {
    const p = registry.payloads[id];
    out.push(row(id, p.content, p.review));
  }
  out.push("", "## Хранилища и потоки вне основной SQLite", "",
    row("Группа", "Статус", "Место", "Принадлежность", "Цели", "Выдача", "Закрытие", "Retention в исходниках", "Жизненный цикл", "Источники", "Разрыв"),
    row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"));
  for (const id of keysAt(registry.stores)) {
    const s = registry.stores[id];
    out.push(row(id, s.scope, s.location, s.subject, s.purposes.join(", "), s.access, s.closure,
      s.retentionPolicies?.join(", ") ?? "—", s.lifecycle, s.sources.join(", "), s.review));
  }
  out.push("", "## Категории технического retention", "",
    row("Категория", "Параметр политики", "Границы в исходниках", "Источник", "Разрыв"),
    row("---", "---", "---", "---", "---"));
  for (const [id, p] of Object.entries(registry.retentionPolicies).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)) {
    out.push(row(id, p.parameter, p.scope, p.source, p.review));
  }
  out.push("", "## Источники классификации", "", row("ID", "Тип", "Ссылка или указатель"), row("---", "---", "---"));
  for (const id of keysAt(registry.sources)) {
    const { kind, ref } = registry.sources[id];
    out.push(row(id, kind, ref));
  }
  out.push("", "## Открытые разрывы и квалификация", "", row("ID", "Plane", "Что подтвердить"), row("---", "---", "---"));
  for (const id of keysAt(registry.gaps)) {
    const { issue, evidence } = registry.gaps[id];
    out.push(row(id, `[${issue}](https://app.plane.so/art-workspace/browse/${issue})`, evidence));
  }
  return out.join("\n") + "\n";
}
