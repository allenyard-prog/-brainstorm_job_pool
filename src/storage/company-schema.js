export const companySchema = `
CREATE TABLE companies(
  id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, website_url TEXT, domain TEXT,
  location TEXT, industry TEXT, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  field_times_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(field_times_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_synced_at TEXT NOT NULL,
  created_sync_id TEXT, last_sync_id TEXT,
  UNIQUE(id,user_id)
);
CREATE INDEX owned_company_names ON companies(user_id,normalized_name,id);
CREATE INDEX company_sync_touches ON companies(last_sync_id,created_sync_id);
CREATE TABLE company_identifiers(
  company_id INTEGER NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('source','domain','name')),
  namespace TEXT NOT NULL DEFAULT '', value TEXT NOT NULL,
  PRIMARY KEY(company_id,kind,namespace,value),
  FOREIGN KEY(company_id,user_id) REFERENCES companies(id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX unique_strong_company_identifier ON company_identifiers(user_id,kind,namespace,value) WHERE kind!='name';
CREATE INDEX company_name_aliases ON company_identifiers(user_id,kind,value);
ALTER TABLE jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);
CREATE INDEX owned_company_jobs ON jobs(user_id,company_id,id);
CREATE TRIGGER job_company_owner_update BEFORE UPDATE OF company_id,user_id ON jobs
WHEN NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM companies WHERE id=NEW.company_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'Invalid company ownership'); END;
CREATE TRIGGER job_company_owner_insert BEFORE INSERT ON jobs
WHEN NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM companies WHERE id=NEW.company_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'Invalid company ownership'); END;
CREATE TABLE company_syncs(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
  total INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, max_job_id INTEGER NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  linked INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, warnings INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, error TEXT
);
CREATE UNIQUE INDEX one_user_company_sync ON company_syncs(user_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX one_running_company_sync ON company_syncs(status) WHERE status='running';
CREATE INDEX owned_company_syncs ON company_syncs(user_id,queued_at,id);
`;
