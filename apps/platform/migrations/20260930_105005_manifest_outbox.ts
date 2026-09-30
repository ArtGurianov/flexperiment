import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`access_operations\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`operation_id\` text NOT NULL,
	\`course_ref\` text NOT NULL,
	\`committed_version\` numeric NOT NULL,
	\`state\` text DEFAULT 'COMMITTED_UNACKED' NOT NULL,
	\`acknowledged_at\` text,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`access_operations_operation_id_idx\` ON \`access_operations\` (\`operation_id\`);`)
  await db.run(sql`CREATE INDEX \`access_operations_course_ref_idx\` ON \`access_operations\` (\`course_ref\`);`)
  await db.run(sql`CREATE INDEX \`access_operations_committed_version_idx\` ON \`access_operations\` (\`committed_version\`);`)
  await db.run(sql`CREATE INDEX \`access_operations_state_idx\` ON \`access_operations\` (\`state\`);`)
  await db.run(sql`CREATE INDEX \`access_operations_updated_at_idx\` ON \`access_operations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`access_operations_created_at_idx\` ON \`access_operations\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_jobs_stats\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`stats\` text,
	\`updated_at\` text,
	\`created_at\` text
  );
  `)
  await db.run(sql`ALTER TABLE \`payload_jobs\` ADD \`meta\` text;`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`access_operations_id\` integer REFERENCES access_operations(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_access_operations_id_idx\` ON \`payload_locked_documents_rels\` (\`access_operations_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`access_operations\`;`)
  await db.run(sql`DROP TABLE \`payload_jobs_stats\`;`)
  await db.run(sql`PRAGMA foreign_keys=OFF;`)
  await db.run(sql`CREATE TABLE \`__new_payload_locked_documents_rels\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`order\` integer,
	\`parent_id\` integer NOT NULL,
	\`path\` text NOT NULL,
	\`users_id\` integer,
	\`media_id\` integer,
	\`courses_id\` integer,
	\`sections_id\` integer,
	\`lessons_id\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`courses_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`sections_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`lessons_id\`) REFERENCES \`lessons\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id", "courses_id", "sections_id", "lessons_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id", "courses_id", "sections_id", "lessons_id" FROM \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`ALTER TABLE \`__new_payload_locked_documents_rels\` RENAME TO \`payload_locked_documents_rels\`;`)
  await db.run(sql`PRAGMA foreign_keys=ON;`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_courses_id_idx\` ON \`payload_locked_documents_rels\` (\`courses_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_sections_id_idx\` ON \`payload_locked_documents_rels\` (\`sections_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_lessons_id_idx\` ON \`payload_locked_documents_rels\` (\`lessons_id\`);`)
  await db.run(sql`ALTER TABLE \`payload_jobs\` DROP COLUMN \`meta\`;`)
}
