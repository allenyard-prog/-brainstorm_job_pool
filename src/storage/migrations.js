import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const activeStates = ['queued', 'starting', 'running', 'stop_requested'];
export const executingStates = ['starting', 'running', 'stop_requested'];
const schema = `
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),created_at TEXT NOT NULL);
CREATE TABLE backend_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON backend_sessions(expires_at);
CREATE TABLE connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),site TEXT NOT NULL,account_key TEXT NOT NULL,label TEXT NOT NULL,encrypted_credentials TEXT NOT NULL,auth_status TEXT NOT NULL DEFAULT 'not_authenticated',cli_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,site,account_key));
CREATE UNIQUE INDEX cli_connection ON connections(site,account_key) WHERE cli_default=1;
CREATE TABLE jobs(id INTEGER PRIMARY KEY,scope_key TEXT NOT NULL,connection_id TEXT REFERENCES connections(id),user_id TEXT REFERENCES users(id),account_key TEXT NOT NULL,site TEXT NOT NULL,source_job_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,company TEXT,details_json TEXT NOT NULL CHECK(json_valid(details_json)),raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),first_seen_at TEXT NOT NULL,last_scraped_at TEXT NOT NULL,UNIQUE(scope_key,source_job_id));
CREATE TABLE job_processing(job_id INTEGER NOT NULL REFERENCES jobs(id),account_key TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('saved','mark_pending','mark_confirmed')),website_status TEXT,last_error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,account_key));
CREATE TABLE runs(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),connection_id TEXT REFERENCES connections(id),site TEXT NOT NULL,account_key TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'collection',transport TEXT NOT NULL,options_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(options_json)),queued_at TEXT NOT NULL,started_at TEXT,ended_at TEXT,status TEXT NOT NULL CHECK(status IN ('queued','starting','running','stop_requested','stopped','completed','failed','attention_required','interrupted')),counters_json TEXT NOT NULL DEFAULT '{"saved":0,"confirmed":0,"failed":0}' CHECK(json_valid(counters_json)),phase TEXT,error TEXT,error_code TEXT,heartbeat_at TEXT,supervisor_id TEXT,pid INTEGER,stop_requested_at TEXT,forced INTEGER NOT NULL DEFAULT 0,parent_run_id TEXT REFERENCES runs(id),available_at INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX one_connection_run ON runs(connection_id) WHERE status IN ('queued','starting','running','stop_requested');
CREATE UNIQUE INDEX one_user_worker ON runs(user_id) WHERE status IN ('starting','running','stop_requested');
CREATE UNIQUE INDEX one_account_worker ON runs(site,account_key) WHERE status IN ('starting','running','stop_requested');
CREATE INDEX queued_runs ON runs(status,available_at,queued_at);
CREATE INDEX owned_runs ON runs(user_id,queued_at);
CREATE TABLE run_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),user_id TEXT REFERENCES users(id),type TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL);
CREATE INDEX owned_events ON run_events(user_id,run_id,id);
CREATE INDEX owned_jobs ON jobs(user_id,id);
CREATE INDEX jobs_title ON jobs(title);
CREATE INDEX processing_state ON job_processing(account_key,state);
`;

export function migrate(db, path) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('Database schema is newer than this application.');
  if (version === 1) return;
  const legacy = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
  if (legacy && path !== ':memory:') {
    for (const row of db.prepare("SELECT DISTINCT site,account_key FROM runs WHERE status='running'").all()) {
      const lockPath = join(dirname(path), 'locks', `${row.site}-${row.account_key}.lock`);
      if (!existsSync(lockPath)) continue;
      let owner;
      try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); }
      catch { throw new Error('Stop the legacy CLI runner and resolve its account lock before migrating.'); }
      try { process.kill(owner.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      throw new Error('Stop the legacy CLI runner before upgrading the database.');
    }
  }
  if (legacy && path !== ':memory:' && !existsSync(`${path}.pre-service.bak`)) db.prepare('VACUUM INTO ?').run(`${path}.pre-service.bak`);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    // Another process may have completed migration while this connection waited.
    if (db.prepare('PRAGMA user_version').get().user_version === 1) { db.exec('COMMIT; PRAGMA foreign_keys=ON'); return; }
    let jobs = [], processing = [], runs = [];
    if (legacy) {
      jobs = db.prepare('SELECT * FROM jobs').all();
      processing = db.prepare('SELECT * FROM job_processing').all();
      runs = db.prepare('SELECT * FROM runs').all();
      db.exec('DROP TABLE job_processing; DROP TABLE jobs; DROP TABLE runs');
    }
    db.exec(schema);
    const insert = db.prepare('INSERT INTO jobs(id,scope_key,account_key,site,source_job_id,url,title,company,details_json,raw_json,first_seen_at,last_scraped_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    let nextId = jobs.reduce((maximum, job) => Math.max(maximum, Number(job.id)), 0) + 1;
    const processingByJob = new Map();
    for (const row of processing) { const rows = processingByJob.get(row.job_id) ?? []; rows.push(row); processingByJob.set(row.job_id, rows); }
    for (const job of jobs) {
      const states = processingByJob.get(job.id) ?? [];
      const copies = states.length ? states : [{ account_key: 'unassigned' }];
      copies.forEach((p, index) => {
        const id = index === 0 ? job.id : nextId++;
        insert.run(id, `legacy:${job.site}:${p.account_key}`, p.account_key, job.site, job.source_job_id, job.url, job.title, job.company, job.details_json, job.raw_json, job.first_seen_at, job.last_scraped_at);
        if (p.job_id) db.prepare('INSERT INTO job_processing VALUES(?,?,?,?,?,?)').run(id, p.account_key, p.state, p.website_status, p.last_error, p.updated_at);
      });
    }
    for (const run of runs) {
      const status = run.status === 'paused' ? 'attention_required' : run.status === 'running' ? 'interrupted' : run.status;
      db.prepare('INSERT INTO runs(id,site,account_key,transport,queued_at,started_at,ended_at,status,counters_json,error) VALUES(?,?,?,?,?,?,?,?,?,?)').run(run.id, run.site, run.account_key, run.transport, run.started_at, run.started_at, run.ended_at, status, run.counters_json, run.error);
    }
    db.exec('PRAGMA user_version=1; COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) { db.exec('ROLLBACK; PRAGMA foreign_keys=ON'); throw error; }
}
