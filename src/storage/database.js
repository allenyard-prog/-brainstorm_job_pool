import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, site TEXT NOT NULL, source_job_id TEXT NOT NULL,
        url TEXT NOT NULL, title TEXT NOT NULL, company TEXT,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
        first_seen_at TEXT NOT NULL, last_scraped_at TEXT NOT NULL,
        UNIQUE(site, source_job_id));
      CREATE TABLE IF NOT EXISTS job_processing (
        job_id INTEGER NOT NULL REFERENCES jobs(id), account_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('saved','mark_pending','mark_confirmed')),
        website_status TEXT, last_error TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(job_id, account_key));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, site TEXT NOT NULL, account_key TEXT NOT NULL,
        transport TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        status TEXT NOT NULL, counters_json TEXT NOT NULL CHECK(json_valid(counters_json)), error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_title ON jobs(title);
      CREATE INDEX IF NOT EXISTS processing_state ON job_processing(account_key,state);`);
  }
  saveJob(site, account, job) {
    if (!job.id || !job.url || !job.title?.trim() || !job.details?.description?.text?.trim()) throw new Error('Job identity, title, URL and description are required before marking applied.');
    const details = JSON.stringify(job.details);
    const raw = job.raw == null ? null : JSON.stringify(job.raw);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`INSERT INTO jobs(site,source_job_id,url,title,company,details_json,raw_json,first_seen_at,last_scraped_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(site,source_job_id) DO UPDATE SET
        url=excluded.url,title=excluded.title,company=excluded.company,details_json=excluded.details_json,
        raw_json=excluded.raw_json,last_scraped_at=excluded.last_scraped_at RETURNING id`).get(site, String(job.id), job.url, job.title, job.company ?? null, details, raw, now, now);
      this.db.prepare(`INSERT INTO job_processing(job_id,account_key,state,updated_at) VALUES(?,?,'saved',?)
        ON CONFLICT(job_id,account_key) DO NOTHING`).run(row.id, account, now);
      this.db.exec('COMMIT');
      return row.id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  state(site, account, sourceId) {
    return this.db.prepare(`SELECT p.* FROM job_processing p JOIN jobs j ON j.id=p.job_id WHERE j.site=? AND j.source_job_id=? AND p.account_key=?`).get(site, String(sourceId), account);
  }
  transition(jobId, account, state, websiteStatus = null, error = null) {
    this.db.prepare('UPDATE job_processing SET state=?,website_status=COALESCE(?,website_status),last_error=?,updated_at=? WHERE job_id=? AND account_key=?')
      .run(state, websiteStatus, error, new Date().toISOString(), jobId, account);
  }
  pending(site, account) {
    return this.db.prepare(`SELECT j.*,p.state FROM jobs j JOIN job_processing p ON j.id=p.job_id WHERE j.site=? AND p.account_key=? AND p.state='mark_pending'`).all(site, account)
      .map(row => ({ ...row, id: row.source_job_id, databaseId: row.id, details: JSON.parse(row.details_json) }));
  }
  confirmedIds(site, account) {
    return this.db.prepare(`SELECT j.source_job_id FROM jobs j JOIN job_processing p ON j.id=p.job_id WHERE j.site=? AND p.account_key=? AND p.state='mark_confirmed'`).all(site, account).map(row => row.source_job_id);
  }
  startRun(site, account, transport) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,NULL,'running','{}',NULL)").run(id, site, account, transport, new Date().toISOString());
    return id;
  }
  finishRun(id, status, counters, error = null) {
    this.db.prepare('UPDATE runs SET ended_at=?,status=?,counters_json=?,error=? WHERE id=?').run(new Date().toISOString(), status, JSON.stringify(counters), error, id);
  }
  jobs(site) {
    return this.db.prepare('SELECT * FROM jobs WHERE site=? ORDER BY id').all(site).map(({ details_json, raw_json, ...row }) => ({ ...row, details: JSON.parse(details_json), raw: raw_json == null ? null : JSON.parse(raw_json) }));
  }
  close() { this.db.close(); }
}
