CREATE TABLE tweets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  date_kst TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  parent_id TEXT,
  parent_text TEXT,
  parent_author TEXT,
  quoted_id TEXT,
  quoted_text TEXT,
  lang TEXT,
  source TEXT NOT NULL
);
CREATE INDEX tweets_year_month ON tweets(year, month);
CREATE INDEX tweets_date ON tweets(date_kst);
CREATE TABLE media (
  tweet_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  r2_key TEXT,
  width INTEGER,
  height INTEGER,
  alt TEXT,
  PRIMARY KEY (tweet_id, idx)
);
CREATE TABLE scores (
  tweet_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  score REAL NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tweet_id, topic)
);
CREATE INDEX scores_topic ON scores(topic, score);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  question TEXT NOT NULL,
  version TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
