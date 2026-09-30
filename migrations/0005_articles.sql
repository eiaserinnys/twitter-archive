ALTER TABLE tweets ADD COLUMN article_title TEXT;
ALTER TABLE tweets ADD COLUMN article_text TEXT;
UPDATE tweets SET article_title = '' WHERE text NOT LIKE '%x.com/i/article/%';
CREATE INDEX tweets_article_unchecked ON tweets(created_at, id) WHERE article_title IS NULL;
