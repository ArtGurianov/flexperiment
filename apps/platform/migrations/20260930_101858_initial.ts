import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`CREATE TABLE \`users_sessions\` (
	\`_order\` integer NOT NULL,
	\`_parent_id\` integer NOT NULL,
	\`id\` text PRIMARY KEY NOT NULL,
	\`created_at\` text,
	\`expires_at\` text NOT NULL,
	FOREIGN KEY (\`_parent_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`users_sessions_order_idx\` ON \`users_sessions\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`users_sessions_parent_id_idx\` ON \`users_sessions\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`users\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`email\` text NOT NULL,
	\`reset_password_token\` text,
	\`reset_password_expiration\` text,
	\`salt\` text,
	\`hash\` text,
	\`reset_password_requested_at\` text,
	\`login_attempts\` numeric DEFAULT 0,
	\`lock_until\` text
  );
  `)
  await db.run(sql`CREATE INDEX \`users_updated_at_idx\` ON \`users\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`users_created_at_idx\` ON \`users\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`users_email_idx\` ON \`users\` (\`email\`);`)
  await db.run(sql`CREATE TABLE \`media\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`alt\` text NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`url\` text,
	\`thumbnail_u_r_l\` text,
	\`filename\` text,
	\`mime_type\` text,
	\`filesize\` numeric,
	\`width\` numeric,
	\`height\` numeric,
	\`focal_x\` numeric,
	\`focal_y\` numeric,
	\`sizes_card_url\` text,
	\`sizes_card_width\` numeric,
	\`sizes_card_height\` numeric,
	\`sizes_card_mime_type\` text,
	\`sizes_card_filesize\` numeric,
	\`sizes_card_filename\` text,
	\`sizes_hero_url\` text,
	\`sizes_hero_width\` numeric,
	\`sizes_hero_height\` numeric,
	\`sizes_hero_mime_type\` text,
	\`sizes_hero_filesize\` numeric,
	\`sizes_hero_filename\` text
  );
  `)
  await db.run(sql`CREATE INDEX \`media_updated_at_idx\` ON \`media\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`media_created_at_idx\` ON \`media\` (\`created_at\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`media_filename_idx\` ON \`media\` (\`filename\`);`)
  await db.run(sql`CREATE INDEX \`media_sizes_card_sizes_card_filename_idx\` ON \`media\` (\`sizes_card_filename\`);`)
  await db.run(sql`CREATE INDEX \`media_sizes_hero_sizes_hero_filename_idx\` ON \`media\` (\`sizes_hero_filename\`);`)
  await db.run(sql`CREATE TABLE \`courses\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`course_ref\` text,
	\`title\` text,
	\`slug\` text,
	\`summary\` text,
	\`description\` text,
	\`hero_id\` integer,
	\`visibility\` text DEFAULT 'listed',
	\`ever_published\` integer DEFAULT false,
	\`manifest_version\` numeric DEFAULT 0,
	\`public_content_updated_at\` text,
	\`display_date\` text,
	\`seo_title\` text,
	\`seo_description\` text,
	\`seo_image_id\` integer,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`_status\` text DEFAULT 'draft',
	FOREIGN KEY (\`hero_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`seo_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`courses_course_ref_idx\` ON \`courses\` (\`course_ref\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`courses_slug_idx\` ON \`courses\` (\`slug\`);`)
  await db.run(sql`CREATE INDEX \`courses_hero_idx\` ON \`courses\` (\`hero_id\`);`)
  await db.run(sql`CREATE INDEX \`courses_visibility_idx\` ON \`courses\` (\`visibility\`);`)
  await db.run(sql`CREATE INDEX \`courses_seo_seo_image_idx\` ON \`courses\` (\`seo_image_id\`);`)
  await db.run(sql`CREATE INDEX \`courses_updated_at_idx\` ON \`courses\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`courses_created_at_idx\` ON \`courses\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`courses__status_idx\` ON \`courses\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`_courses_v\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`parent_id\` integer,
	\`version_course_ref\` text,
	\`version_title\` text,
	\`version_slug\` text,
	\`version_summary\` text,
	\`version_description\` text,
	\`version_hero_id\` integer,
	\`version_visibility\` text DEFAULT 'listed',
	\`version_ever_published\` integer DEFAULT false,
	\`version_manifest_version\` numeric DEFAULT 0,
	\`version_public_content_updated_at\` text,
	\`version_display_date\` text,
	\`version_seo_title\` text,
	\`version_seo_description\` text,
	\`version_seo_image_id\` integer,
	\`version_updated_at\` text,
	\`version_created_at\` text,
	\`version__status\` text DEFAULT 'draft',
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`latest\` integer,
	\`autosave\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`version_hero_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`version_seo_image_id\`) REFERENCES \`media\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_courses_v_parent_idx\` ON \`_courses_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_course_ref_idx\` ON \`_courses_v\` (\`version_course_ref\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_slug_idx\` ON \`_courses_v\` (\`version_slug\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_hero_idx\` ON \`_courses_v\` (\`version_hero_id\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_visibility_idx\` ON \`_courses_v\` (\`version_visibility\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_seo_version_seo_image_idx\` ON \`_courses_v\` (\`version_seo_image_id\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_updated_at_idx\` ON \`_courses_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version_created_at_idx\` ON \`_courses_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_version_version__status_idx\` ON \`_courses_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_created_at_idx\` ON \`_courses_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_updated_at_idx\` ON \`_courses_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_latest_idx\` ON \`_courses_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX \`_courses_v_autosave_idx\` ON \`_courses_v\` (\`autosave\`);`)
  await db.run(sql`CREATE TABLE \`sections\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`section_ref\` text,
	\`course_id\` integer,
	\`title\` text,
	\`position\` numeric,
	\`visibility\` text DEFAULT 'listed',
	\`ever_published\` integer DEFAULT false,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`_status\` text DEFAULT 'draft',
	FOREIGN KEY (\`course_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`sections_section_ref_idx\` ON \`sections\` (\`section_ref\`);`)
  await db.run(sql`CREATE INDEX \`sections_course_idx\` ON \`sections\` (\`course_id\`);`)
  await db.run(sql`CREATE INDEX \`sections_visibility_idx\` ON \`sections\` (\`visibility\`);`)
  await db.run(sql`CREATE INDEX \`sections_updated_at_idx\` ON \`sections\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`sections_created_at_idx\` ON \`sections\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`sections__status_idx\` ON \`sections\` (\`_status\`);`)
  await db.run(sql`CREATE TABLE \`_sections_v\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`parent_id\` integer,
	\`version_section_ref\` text,
	\`version_course_id\` integer,
	\`version_title\` text,
	\`version_position\` numeric,
	\`version_visibility\` text DEFAULT 'listed',
	\`version_ever_published\` integer DEFAULT false,
	\`version_updated_at\` text,
	\`version_created_at\` text,
	\`version__status\` text DEFAULT 'draft',
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`latest\` integer,
	\`autosave\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`version_course_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_sections_v_parent_idx\` ON \`_sections_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_section_ref_idx\` ON \`_sections_v\` (\`version_section_ref\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_course_idx\` ON \`_sections_v\` (\`version_course_id\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_visibility_idx\` ON \`_sections_v\` (\`version_visibility\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_updated_at_idx\` ON \`_sections_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version_created_at_idx\` ON \`_sections_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_version_version__status_idx\` ON \`_sections_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_created_at_idx\` ON \`_sections_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_updated_at_idx\` ON \`_sections_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_latest_idx\` ON \`_sections_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX \`_sections_v_autosave_idx\` ON \`_sections_v\` (\`autosave\`);`)
  await db.run(sql`CREATE TABLE \`lessons\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`lesson_ref\` text,
	\`course_id\` integer,
	\`section_id\` integer,
	\`title\` text,
	\`slug\` text,
	\`description\` text,
	\`position\` numeric,
	\`duration_seconds\` numeric,
	\`free_preview\` integer DEFAULT false,
	\`visibility\` text DEFAULT 'listed',
	\`ever_published\` integer DEFAULT false,
	\`seo_title\` text,
	\`seo_description\` text,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`_status\` text DEFAULT 'draft',
	FOREIGN KEY (\`course_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`section_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`lessons_lesson_ref_idx\` ON \`lessons\` (\`lesson_ref\`);`)
  await db.run(sql`CREATE INDEX \`lessons_course_idx\` ON \`lessons\` (\`course_id\`);`)
  await db.run(sql`CREATE INDEX \`lessons_section_idx\` ON \`lessons\` (\`section_id\`);`)
  await db.run(sql`CREATE INDEX \`lessons_visibility_idx\` ON \`lessons\` (\`visibility\`);`)
  await db.run(sql`CREATE INDEX \`lessons_updated_at_idx\` ON \`lessons\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`lessons_created_at_idx\` ON \`lessons\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`lessons__status_idx\` ON \`lessons\` (\`_status\`);`)
  await db.run(sql`CREATE UNIQUE INDEX \`course_slug_idx\` ON \`lessons\` (\`course_id\`,\`slug\`);`)
  await db.run(sql`CREATE TABLE \`_lessons_v\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`parent_id\` integer,
	\`version_lesson_ref\` text,
	\`version_course_id\` integer,
	\`version_section_id\` integer,
	\`version_title\` text,
	\`version_slug\` text,
	\`version_description\` text,
	\`version_position\` numeric,
	\`version_duration_seconds\` numeric,
	\`version_free_preview\` integer DEFAULT false,
	\`version_visibility\` text DEFAULT 'listed',
	\`version_ever_published\` integer DEFAULT false,
	\`version_seo_title\` text,
	\`version_seo_description\` text,
	\`version_updated_at\` text,
	\`version_created_at\` text,
	\`version__status\` text DEFAULT 'draft',
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`latest\` integer,
	\`autosave\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`lessons\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`version_course_id\`) REFERENCES \`courses\`(\`id\`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (\`version_section_id\`) REFERENCES \`sections\`(\`id\`) ON UPDATE no action ON DELETE set null
  );
  `)
  await db.run(sql`CREATE INDEX \`_lessons_v_parent_idx\` ON \`_lessons_v\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_lesson_ref_idx\` ON \`_lessons_v\` (\`version_lesson_ref\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_course_idx\` ON \`_lessons_v\` (\`version_course_id\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_section_idx\` ON \`_lessons_v\` (\`version_section_id\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_visibility_idx\` ON \`_lessons_v\` (\`version_visibility\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_updated_at_idx\` ON \`_lessons_v\` (\`version_updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version_created_at_idx\` ON \`_lessons_v\` (\`version_created_at\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_version_version__status_idx\` ON \`_lessons_v\` (\`version__status\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_created_at_idx\` ON \`_lessons_v\` (\`created_at\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_updated_at_idx\` ON \`_lessons_v\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_latest_idx\` ON \`_lessons_v\` (\`latest\`);`)
  await db.run(sql`CREATE INDEX \`_lessons_v_autosave_idx\` ON \`_lessons_v\` (\`autosave\`);`)
  await db.run(sql`CREATE INDEX \`version_course_version_slug_idx\` ON \`_lessons_v\` (\`version_course_id\`,\`version_slug\`);`)
  await db.run(sql`CREATE TABLE \`payload_kv\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`key\` text NOT NULL,
	\`data\` text NOT NULL
  );
  `)
  await db.run(sql`CREATE UNIQUE INDEX \`payload_kv_key_idx\` ON \`payload_kv\` (\`key\`);`)
  await db.run(sql`CREATE TABLE \`payload_jobs_log\` (
	\`_order\` integer NOT NULL,
	\`_parent_id\` integer NOT NULL,
	\`id\` text PRIMARY KEY NOT NULL,
	\`executed_at\` text NOT NULL,
	\`completed_at\` text NOT NULL,
	\`task_slug\` text NOT NULL,
	\`task_i_d\` text NOT NULL,
	\`input\` text,
	\`output\` text,
	\`state\` text NOT NULL,
	\`error\` text,
	FOREIGN KEY (\`_parent_id\`) REFERENCES \`payload_jobs\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_jobs_log_order_idx\` ON \`payload_jobs_log\` (\`_order\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_log_parent_id_idx\` ON \`payload_jobs_log\` (\`_parent_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_jobs\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`input\` text,
	\`completed_at\` text,
	\`total_tried\` numeric DEFAULT 0,
	\`has_error\` integer DEFAULT false,
	\`error\` text,
	\`task_slug\` text,
	\`queue\` text DEFAULT 'default',
	\`wait_until\` text,
	\`processing\` integer DEFAULT false,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_jobs_completed_at_idx\` ON \`payload_jobs\` (\`completed_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_total_tried_idx\` ON \`payload_jobs\` (\`total_tried\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_has_error_idx\` ON \`payload_jobs\` (\`has_error\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_task_slug_idx\` ON \`payload_jobs\` (\`task_slug\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_queue_idx\` ON \`payload_jobs\` (\`queue\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_wait_until_idx\` ON \`payload_jobs\` (\`wait_until\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_processing_idx\` ON \`payload_jobs\` (\`processing\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_updated_at_idx\` ON \`payload_jobs\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_jobs_created_at_idx\` ON \`payload_jobs\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`global_slug\` text,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_global_slug_idx\` ON \`payload_locked_documents\` (\`global_slug\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_updated_at_idx\` ON \`payload_locked_documents\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_created_at_idx\` ON \`payload_locked_documents\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_locked_documents_rels\` (
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
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_order_idx\` ON \`payload_locked_documents_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_parent_idx\` ON \`payload_locked_documents_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_path_idx\` ON \`payload_locked_documents_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_users_id_idx\` ON \`payload_locked_documents_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_media_id_idx\` ON \`payload_locked_documents_rels\` (\`media_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_courses_id_idx\` ON \`payload_locked_documents_rels\` (\`courses_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_sections_id_idx\` ON \`payload_locked_documents_rels\` (\`sections_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_locked_documents_rels_lessons_id_idx\` ON \`payload_locked_documents_rels\` (\`lessons_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`key\` text,
	\`value\` text,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_key_idx\` ON \`payload_preferences\` (\`key\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_updated_at_idx\` ON \`payload_preferences\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_created_at_idx\` ON \`payload_preferences\` (\`created_at\`);`)
  await db.run(sql`CREATE TABLE \`payload_preferences_rels\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`order\` integer,
	\`parent_id\` integer NOT NULL,
	\`path\` text NOT NULL,
	\`users_id\` integer,
	FOREIGN KEY (\`parent_id\`) REFERENCES \`payload_preferences\`(\`id\`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (\`users_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_order_idx\` ON \`payload_preferences_rels\` (\`order\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_parent_idx\` ON \`payload_preferences_rels\` (\`parent_id\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_path_idx\` ON \`payload_preferences_rels\` (\`path\`);`)
  await db.run(sql`CREATE INDEX \`payload_preferences_rels_users_id_idx\` ON \`payload_preferences_rels\` (\`users_id\`);`)
  await db.run(sql`CREATE TABLE \`payload_migrations\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`name\` text,
	\`batch\` numeric,
	\`updated_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	\`created_at\` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
  );
  `)
  await db.run(sql`CREATE INDEX \`payload_migrations_updated_at_idx\` ON \`payload_migrations\` (\`updated_at\`);`)
  await db.run(sql`CREATE INDEX \`payload_migrations_created_at_idx\` ON \`payload_migrations\` (\`created_at\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP TABLE \`users_sessions\`;`)
  await db.run(sql`DROP TABLE \`users\`;`)
  await db.run(sql`DROP TABLE \`media\`;`)
  await db.run(sql`DROP TABLE \`courses\`;`)
  await db.run(sql`DROP TABLE \`_courses_v\`;`)
  await db.run(sql`DROP TABLE \`sections\`;`)
  await db.run(sql`DROP TABLE \`_sections_v\`;`)
  await db.run(sql`DROP TABLE \`lessons\`;`)
  await db.run(sql`DROP TABLE \`_lessons_v\`;`)
  await db.run(sql`DROP TABLE \`payload_kv\`;`)
  await db.run(sql`DROP TABLE \`payload_jobs_log\`;`)
  await db.run(sql`DROP TABLE \`payload_jobs\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents\`;`)
  await db.run(sql`DROP TABLE \`payload_locked_documents_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences\`;`)
  await db.run(sql`DROP TABLE \`payload_preferences_rels\`;`)
  await db.run(sql`DROP TABLE \`payload_migrations\`;`)
}
