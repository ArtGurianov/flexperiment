-- Editorial drafts and committed history share the existing published projection graph.
ALTER TABLE catalog_course_projection ADD COLUMN authoring_source TEXT NOT NULL DEFAULT 'LEGACY_MANIFEST'
  CHECK (authoring_source IN ('LEGACY_MANIFEST', 'COMMERCE_EDITORIAL'));
ALTER TABLE catalog_course_projection ADD COLUMN title TEXT;
ALTER TABLE catalog_course_projection ADD COLUMN slug TEXT;
ALTER TABLE catalog_course_projection ADD COLUMN summary TEXT;
ALTER TABLE catalog_course_projection ADD COLUMN description_json TEXT CHECK (description_json IS NULL OR json_valid(description_json));
ALTER TABLE catalog_course_projection ADD COLUMN seo_json TEXT CHECK (seo_json IS NULL OR json_valid(seo_json));
ALTER TABLE catalog_section_projection ADD COLUMN title TEXT;
ALTER TABLE catalog_lesson_projection ADD COLUMN title TEXT;
ALTER TABLE catalog_lesson_projection ADD COLUMN slug TEXT;
ALTER TABLE catalog_lesson_projection ADD COLUMN description_json TEXT CHECK (description_json IS NULL OR json_valid(description_json));
ALTER TABLE catalog_lesson_projection ADD COLUMN seo_json TEXT CHECK (seo_json IS NULL OR json_valid(seo_json));

CREATE UNIQUE INDEX editorial_course_slug_unique ON catalog_course_projection(slug)
  WHERE authoring_source='COMMERCE_EDITORIAL' AND slug IS NOT NULL;
CREATE UNIQUE INDEX editorial_lesson_slug_unique ON catalog_lesson_projection(course_ref,slug)
  WHERE slug IS NOT NULL;

CREATE TABLE course_editorial_drafts (
  course_ref TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  document_json TEXT NOT NULL CHECK (json_valid(document_json) AND length(document_json) <= 262144),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE course_editorial_versions (
  course_ref TEXT NOT NULL REFERENCES catalog_course_projection(course_ref),
  version INTEGER NOT NULL CHECK (version >= 1),
  draft_revision INTEGER NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  actor TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (course_ref,version)
);
CREATE TABLE course_editorial_publish_commands (
  course_ref TEXT NOT NULL REFERENCES catalog_course_projection(course_ref),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (course_ref,idempotency_key)
);

CREATE TRIGGER editorial_version_no_update BEFORE UPDATE ON course_editorial_versions
BEGIN SELECT RAISE(ABORT,'EDITORIAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER editorial_version_no_delete BEFORE DELETE ON course_editorial_versions
BEGIN SELECT RAISE(ABORT,'EDITORIAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER editorial_course_no_delete BEFORE DELETE ON catalog_course_projection
WHEN OLD.authoring_source='COMMERCE_EDITORIAL'
BEGIN SELECT RAISE(ABORT,'EDITORIAL_COURSE_IMMUTABLE'); END;
CREATE TRIGGER editorial_course_identity BEFORE UPDATE OF course_ref,slug,authoring_source ON catalog_course_projection
WHEN OLD.authoring_source='COMMERCE_EDITORIAL' AND
  (NEW.course_ref<>OLD.course_ref OR NEW.slug IS NOT OLD.slug OR NEW.authoring_source<>OLD.authoring_source)
BEGIN SELECT RAISE(ABORT,'EDITORIAL_COURSE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER editorial_section_no_delete BEFORE DELETE ON catalog_section_projection
WHEN (SELECT authoring_source FROM catalog_course_projection WHERE course_ref=OLD.course_ref)='COMMERCE_EDITORIAL'
BEGIN SELECT RAISE(ABORT,'EDITORIAL_SECTION_IMMUTABLE'); END;
CREATE TRIGGER editorial_section_identity BEFORE UPDATE OF section_ref,course_ref ON catalog_section_projection
WHEN (SELECT authoring_source FROM catalog_course_projection WHERE course_ref=OLD.course_ref)='COMMERCE_EDITORIAL'
  AND (NEW.section_ref<>OLD.section_ref OR NEW.course_ref<>OLD.course_ref)
BEGIN SELECT RAISE(ABORT,'EDITORIAL_SECTION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER editorial_lesson_no_delete BEFORE DELETE ON catalog_lesson_projection
WHEN (SELECT authoring_source FROM catalog_course_projection WHERE course_ref=OLD.course_ref)='COMMERCE_EDITORIAL'
BEGIN SELECT RAISE(ABORT,'EDITORIAL_LESSON_IMMUTABLE'); END;
CREATE TRIGGER editorial_lesson_identity BEFORE UPDATE OF lesson_ref,course_ref,section_ref,slug ON catalog_lesson_projection
WHEN (SELECT authoring_source FROM catalog_course_projection WHERE course_ref=OLD.course_ref)='COMMERCE_EDITORIAL'
  AND (NEW.lesson_ref<>OLD.lesson_ref OR NEW.course_ref<>OLD.course_ref OR NEW.section_ref<>OLD.section_ref OR NEW.slug IS NOT OLD.slug)
BEGIN SELECT RAISE(ABORT,'EDITORIAL_LESSON_IDENTITY_IMMUTABLE'); END;
