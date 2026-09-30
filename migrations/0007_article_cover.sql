ALTER TABLE tweets ADD COLUMN article_cover_key TEXT;
UPDATE tweets SET article_title = NULL WHERE article_title IS NOT NULL AND article_title <> '';
