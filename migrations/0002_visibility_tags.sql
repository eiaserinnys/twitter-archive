ALTER TABLE topics ADD COLUMN timeline_visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE topics ADD COLUMN search_visibility TEXT NOT NULL DEFAULT 'public';
CREATE TABLE period_tags (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  note TEXT,
  visibility TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX period_tags_start ON period_tags(start_date);
