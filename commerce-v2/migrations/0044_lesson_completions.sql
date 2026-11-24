-- FLEX-129: the first explicit completion survives syllabus revisions and is
-- erased with the subject. Lesson refs are stable editorial identities.
CREATE TABLE lesson_completions (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  lesson_ref TEXT NOT NULL,
  first_completed_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, lesson_ref)
);

CREATE TRIGGER lesson_completion_immutable BEFORE UPDATE ON lesson_completions
BEGIN SELECT RAISE(ABORT, 'LESSON_COMPLETION_IMMUTABLE'); END;
