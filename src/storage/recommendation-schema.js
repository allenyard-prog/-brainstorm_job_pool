export const recommendationSchema = `
ALTER TABLE connections ADD COLUMN specialization_prompt TEXT;
ALTER TABLE connections ADD COLUMN specialization_model_json TEXT CHECK(specialization_model_json IS NULL OR json_valid(specialization_model_json));
ALTER TABLE jobs ADD COLUMN preferred_title_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ai_recommendations(
  id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','stop_requested','completed','stopped','failed','interrupted')),
  total INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,unchanged INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,started_at TEXT,ended_at TEXT,error_code TEXT
);
CREATE UNIQUE INDEX one_user_recommendation ON ai_recommendations(user_id) WHERE status IN ('queued','running','stop_requested');
CREATE INDEX owned_recommendations ON ai_recommendations(user_id,queued_at,id);
CREATE TABLE ai_recommendation_jobs(
  recommendation_id TEXT NOT NULL REFERENCES ai_recommendations(id),job_id INTEGER NOT NULL REFERENCES jobs(id),
  expected_revision INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','working','updated','unchanged','unmatched','skipped','failed')),
  error_code TEXT,
  PRIMARY KEY(recommendation_id,job_id)
);
CREATE INDEX recommendation_pending_jobs ON ai_recommendation_jobs(recommendation_id,status,job_id);
`;
