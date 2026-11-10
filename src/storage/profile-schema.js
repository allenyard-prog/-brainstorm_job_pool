export const profileTitlesSchema = `
ALTER TABLE connections ADD COLUMN person_name TEXT;
CREATE TABLE profile_titles(
  id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL REFERENCES connections(id),
  title TEXT NOT NULL,normalized_title TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(connection_id,normalized_title)
);
CREATE INDEX owned_profile_titles ON profile_titles(user_id,connection_id,is_archived);
ALTER TABLE jobs ADD COLUMN preferred_title_id TEXT REFERENCES profile_titles(id);
CREATE INDEX jobs_preferred_title ON jobs(user_id,preferred_title_id,id);
`;
