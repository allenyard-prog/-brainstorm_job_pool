import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from './migrations.js';

export class Store {
  constructor(path, { connectionId = null, userId = null } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
      migrate(this.db, path);
    } catch (error) { this.db.close(); throw error; }
    this.connectionId = connectionId; this.userId = userId;
    if (connectionId && !this.db.prepare('SELECT id FROM connections WHERE id=? AND user_id=?').get(connectionId, userId)) { this.db.close(); throw new Error('Invalid worker connection ownership.'); }
  }
  scope(site, account) {
    const connection = this.connectionId ? this.db.prepare('SELECT id,user_id FROM connections WHERE id=? AND user_id=? AND site=? AND account_key=?').get(this.connectionId, this.userId, site, account)
      : this.db.prepare('SELECT id,user_id FROM connections WHERE site=? AND account_key=? AND cli_default=1').get(site, account);
    if (this.connectionId && !connection) throw new Error('Connection identity does not match the worker account.');
    return { scope: connection?.id ?? `legacy:${site}:${account}`, connection: connection?.id ?? null, user: connection?.user_id ?? null };
  }
  saveJob(site, account, job) {
    if (!job.id || !job.url || !job.title?.trim() || !job.details?.description?.text?.trim()) throw new Error('Job identity, title, URL and description are required before marking applied.');
    const details = JSON.stringify(job.details);
    const raw = job.raw == null ? null : JSON.stringify(job.raw);
    const now = new Date().toISOString();
    const owner = this.scope(site, account);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`INSERT INTO jobs(scope_key,connection_id,user_id,account_key,site,source_job_id,url,title,company,details_json,raw_json,first_seen_at,last_scraped_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,source_job_id) DO UPDATE SET
        url=excluded.url,title=excluded.title,company=excluded.company,details_json=excluded.details_json,
        raw_json=excluded.raw_json,last_scraped_at=excluded.last_scraped_at RETURNING id`).get(owner.scope, owner.connection, owner.user, account, site, String(job.id), job.url, job.title, job.company ?? null, details, raw, now, now);
      this.db.prepare(`INSERT INTO job_processing(job_id,account_key,state,updated_at) VALUES(?,?,'saved',?)
        ON CONFLICT(job_id,account_key) DO NOTHING`).run(row.id, account, now);
      this.db.exec('COMMIT');
      return row.id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  state(site, account, sourceId) {
    return this.db.prepare(`SELECT p.* FROM job_processing p JOIN jobs j ON j.id=p.job_id WHERE j.scope_key=? AND j.source_job_id=? AND p.account_key=?`).get(this.scope(site, account).scope, String(sourceId), account);
  }
  transition(jobId, account, state, websiteStatus = null, error = null) {
    this.db.prepare('UPDATE job_processing SET state=?,website_status=COALESCE(?,website_status),last_error=?,updated_at=? WHERE job_id=? AND account_key=? AND job_id IN (SELECT id FROM jobs WHERE (? IS NULL OR connection_id=?))')
      .run(state, websiteStatus, error, new Date().toISOString(), jobId, account, this.connectionId, this.connectionId);
  }
  pending(site, account) {
    return this.db.prepare(`SELECT j.*,p.state FROM jobs j JOIN job_processing p ON j.id=p.job_id WHERE j.scope_key=? AND p.account_key=? AND p.state='mark_pending'`).all(this.scope(site, account).scope, account)
      .map(row => ({ ...row, id: row.source_job_id, databaseId: row.id, details: JSON.parse(row.details_json) }));
  }
  confirmedIds(site, account) {
    return this.db.prepare(`SELECT j.source_job_id FROM jobs j JOIN job_processing p ON j.id=p.job_id WHERE j.scope_key=? AND p.account_key=? AND p.state='mark_confirmed'`).all(this.scope(site, account).scope, account).map(row => row.source_job_id);
  }
  startRun(site, account, transport) {
    const id = randomUUID();
    const owner = this.scope(site, account);
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO runs(id,user_id,connection_id,site,account_key,transport,queued_at,started_at,status,pid) VALUES(?,?,?,?,?,?,?,?,'running',?)").run(id, owner.user, owner.connection, site, account, transport, now, now, process.pid);
    return id;
  }
  finishRun(id, status, counters, error = null) {
    this.db.prepare("UPDATE runs SET ended_at=?,status=?,phase=?,counters_json=?,error=? WHERE id=? AND status IN ('queued','starting','running','stop_requested')").run(new Date().toISOString(), status === 'paused' ? 'attention_required' : status, status, JSON.stringify(counters), error, id);
  }
  jobs(site) {
    return this.db.prepare('SELECT * FROM jobs WHERE site=? ORDER BY id').all(site).map(({ details_json, raw_json, ...row }) => ({ ...row, details: JSON.parse(details_json), raw: raw_json == null ? null : JSON.parse(raw_json) }));
  }
  close() { this.db.close(); }
}
