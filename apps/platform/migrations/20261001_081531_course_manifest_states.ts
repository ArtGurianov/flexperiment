import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`course_manifest_states\` (
  	\`id\` integer PRIMARY KEY NOT NULL,
  	\`course_ref\` text NOT NULL,
  	\`manifest_version\` numeric NOT NULL,
  	\`public_content_updated_at\` text NOT NULL,
  	\`invalidated_version\` numeric DEFAULT 0,
  	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`course_manifest_states_course_ref_idx\` ON \`course_manifest_states\` (\`course_ref\`);`)
  await db.run(sql`CREATE INDEX \`course_manifest_states_updated_at_idx\` ON \`course_manifest_states\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`course_manifest_states_created_at_idx\` ON \`course_manifest_states\` (\`created_at\`);`)
  await db.run(sql`ALTER TABLE \`payload_locked_documents_rels\` ADD \`course_manifest_states_id\` integer REFERENCES course_manifest_states(id);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_course_manifest_states_id_idx\` ON \`payload_locked_documents_rels\` (\`course_manifest_states_id\`);`)
  // Carry each committed course's bookkeeping across before the course columns go. Those versions
  // were already invalidated by the previous sync, so the next reconcile is a quiet no-op.
  await db.run(sql`INSERT INTO \`course_manifest_states\` (\`course_ref\`, \`manifest_version\`, \`public_content_updated_at\`, \`invalidated_version\`)
    SELECT \`course_ref\`, \`manifest_version\`, COALESCE(\`public_content_updated_at\`, \`updated_at\`), \`manifest_version\`
    FROM \`courses\` WHERE \`course_ref\` IS NOT NULL AND \`manifest_version\` >= 1;`)
  await db.run(sql`ALTER TABLE \`courses\` DROP COLUMN \`manifest_version\`;`)
  await db.run(sql`ALTER TABLE \`courses\` DROP COLUMN \`public_content_updated_at\`;`)
  await db.run(sql`ALTER TABLE \`_courses_v\` DROP COLUMN \`version_manifest_version\`;`)
  await db.run(sql`ALTER TABLE \`_courses_v\` DROP COLUMN \`version_public_content_updated_at\`;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`courses\` ADD \`manifest_version\` numeric DEFAULT 0;`)
  await db.run(sql`ALTER TABLE \`courses\` ADD \`public_content_updated_at\` text;`)
  await db.run(sql`UPDATE \`courses\` SET
    \`manifest_version\` = COALESCE((SELECT \`manifest_version\` FROM \`course_manifest_states\` state WHERE state.\`course_ref\` = \`courses\`.\`course_ref\`), 0),
    \`public_content_updated_at\` = (SELECT \`public_content_updated_at\` FROM \`course_manifest_states\` state WHERE state.\`course_ref\` = \`courses\`.\`course_ref\`);`)
  await db.run(sql`DROP TABLE \`course_manifest_states\`;`)
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
  	\`access_operations_id\` integer,
  	\`search_id\` integer,
  	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_locked_documents\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`media_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`courses_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`sections_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`lessons_id\`) REFERENCES \`lessons\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`access_operations_id\`) REFERENCES \`access_operations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  	FOREIGN KEY (\`search_id\`) REFERENCES \`search\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`INSERT INTO \`__new_payload_locked_documents_rels\`("id", "order", "parent_id", "path", "users_id", "media_id", "courses_id", "sections_id", "lessons_id", "access_operations_id", "search_id") SELECT "id", "order", "parent_id", "path", "users_id", "media_id", "courses_id", "sections_id", "lessons_id", "access_operations_id", "search_id" FROM \`payload_locked_documents_rels\`;`)
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
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_access_operations_id_idx\` ON \`payload_locked_documents_rels\` (\`access_operations_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_search_id_idx\` ON \`payload_locked_documents_rels\` (\`search_id\`);`)
  await db.run(sql`ALTER TABLE \`_courses_v\` ADD \`version_manifest_version\` numeric DEFAULT 0;`)
  await db.run(sql`ALTER TABLE \`_courses_v\` ADD \`version_public_content_updated_at\` text;`)
}
