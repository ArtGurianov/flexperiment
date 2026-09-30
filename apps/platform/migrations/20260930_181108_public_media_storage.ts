import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`media\` ADD \`prefix\` text DEFAULT 'media';`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`_objectkey\` text;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_url\` text;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_width\` numeric;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_height\` numeric;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_mime_type\` text;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_filesize\` numeric;`)
  await db.run(sql`ALTER TABLE \`media\` ADD \`sizes_og_filename\` text;`)
  await db.run(sql`CREATE INDEX \`media_sizes_og_sizes_og_filename_idx\` ON \`media\` (\`sizes_og_filename\`);`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`media_sizes_og_sizes_og_filename_idx\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`prefix\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`_objectkey\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_url\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_width\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_height\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_mime_type\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_filesize\`;`)
  await db.run(sql`ALTER TABLE \`media\` DROP COLUMN \`sizes_og_filename\`;`)
}
