CREATE TABLE link_previews (
  url TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT,
  description TEXT,
  image TEXT,
  site_name TEXT,
  fetched_at TEXT NOT NULL
);
