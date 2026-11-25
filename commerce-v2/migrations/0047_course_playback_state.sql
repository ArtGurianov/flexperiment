-- FLEX-130: one cursor and the last accepted playback state for each course.
CREATE TABLE course_playback_state (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  course_ref TEXT NOT NULL,
  issued_lesson_ref TEXT NOT NULL,
  issued_cursor TEXT NOT NULL,
  played_lesson_ref TEXT,
  played_cursor TEXT,
  phase TEXT CHECK (phase IN ('PLAYING','ENDED')),
  PRIMARY KEY (customer_id, course_ref),
  CHECK ((played_lesson_ref IS NULL AND played_cursor IS NULL AND phase IS NULL)
      OR (played_lesson_ref IS NOT NULL AND played_cursor IS NOT NULL AND phase IS NOT NULL))
);
