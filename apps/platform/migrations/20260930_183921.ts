import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`ALTER TABLE \`sections\` ADD \`_sections_sections_order\` text;`)
  await db.run(sql`CREATE INDEX \`sections__sections_sections_order_idx\` ON \`sections\` (\`_sections_sections_order\`);`)
  await db.run(sql`ALTER TABLE \`_sections_v\` ADD \`version__sections_sections_order\` text;`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version__sections_sections_order_idx\` ON \`_sections_v\` (\`version__sections_sections_order\`);`)
  await db.run(sql`ALTER TABLE \`lessons\` ADD \`_lessons_lessons_order\` text;`)
  await db.run(sql`CREATE INDEX \`lessons__lessons_lessons_order_idx\` ON \`lessons\` (\`_lessons_lessons_order\`);`)
  await db.run(sql`ALTER TABLE \`_lessons_v\` ADD \`version__lessons_lessons_order\` text;`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version__lessons_lessons_order_idx\` ON \`_lessons_v\` (\`version__lessons_lessons_order\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`sections__sections_sections_order_idx\`;`)
  await db.run(sql`ALTER TABLE \`sections\` DROP COLUMN \`_sections_sections_order\`;`)
  await db.run(sql`DROP INDEX \`_sections_v_version_version__sections_sections_order_idx\`;`)
  await db.run(sql`ALTER TABLE \`_sections_v\` DROP COLUMN \`version__sections_sections_order\`;`)
  await db.run(sql`DROP INDEX \`lessons__lessons_lessons_order_idx\`;`)
  await db.run(sql`ALTER TABLE \`lessons\` DROP COLUMN \`_lessons_lessons_order\`;`)
  await db.run(sql`DROP INDEX \`_lessons_v_version_version__lessons_lessons_order_idx\`;`)
  await db.run(sql`ALTER TABLE \`_lessons_v\` DROP COLUMN \`version__lessons_lessons_order\`;`)
}
