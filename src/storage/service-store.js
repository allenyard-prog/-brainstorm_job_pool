import { randomUUID } from 'node:crypto';
import { CompanyStore, companyRpcMethods } from './company-store.js';
import { ServiceError, notFound } from '../service/errors.js';
import { jobWhere } from './job-filters.js';
import { jobSortFields, listSorting } from './list-sorting.js';

const now = () => new Date().toISOString();
const active = "('queued','starting','running','stop_requested')";
const executing = "('starting','running','stop_requested')";
export const userDto = row => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at });
export const connectionDto = row => ({ id: row.id, site: row.site, label: row.label, authStatus: row.auth_status, createdAt: row.created_at, updatedAt: row.updated_at });
export const runDto = row => ({ id: row.id, connectionId: row.connection_id, site: row.site, kind: row.kind, transport: row.transport, options: JSON.parse(row.options_json), status: row.status, phase: row.phase, queuedAt: row.queued_at, startedAt: row.started_at, endedAt: row.ended_at, heartbeatAt: row.heartbeat_at, counters: JSON.parse(row.counters_json), error: row.error ? { code: row.error_code ?? 'EXECUTION_ERROR', message: row.error } : null, forced: !!row.forced, parentRunId: row.parent_run_id });

export class ServiceStore extends CompanyStore {
  ping() { return this.db.prepare('SELECT 1 AS ok').get(); }
  createUser({ email, passwordHash, role = 'user', bootstrap = false }) {
    return this.transaction(() => {
      if (bootstrap && this.db.prepare("SELECT id FROM users WHERE role='admin'").get()) throw new ServiceError(409, 'ADMIN_EXISTS', 'An administrator already exists.');
      const id = randomUUID();
      try { this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, email.toLowerCase(), passwordHash, role, now()); }
      catch (error) { if (error.code?.startsWith('ERR_SQLITE') && /UNIQUE/.test(error.message)) throw new ServiceError(409, 'USER_EXISTS', 'User already exists.'); throw error; }
      return userDto(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  listUsers() { return this.db.prepare('SELECT id,email,role,created_at FROM users ORDER BY created_at').all().map(userDto); }
  findUser(email) { return this.db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email); }
  createSession({ tokenHash, userId, expiresAt }) {
    this.db.prepare('DELETE FROM backend_sessions WHERE expires_at<?').run(Date.now());
    this.db.prepare('INSERT INTO backend_sessions VALUES(?,?,?)').run(tokenHash, userId, expiresAt);
  }
  sessionUser(tokenHash) {
    const row = this.db.prepare('SELECT u.* FROM backend_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash, Date.now());
    return row ? userDto(row) : null;
  }
  deleteSession(tokenHash) { this.db.prepare('DELETE FROM backend_sessions WHERE token_hash=?').run(tokenHash); }
  createConnection({ userId, site, accountKey, label, encryptedCredentials, cliDefault = false }) {
    const id = randomUUID(), date = now();
    try { this.db.prepare('INSERT INTO connections(id,user_id,site,account_key,label,encrypted_credentials,cli_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, userId, site, accountKey, label, encryptedCredentials, Number(cliDefault), date, date); }
    catch (error) { if (/UNIQUE/.test(error.message)) throw new ServiceError(409, 'CONNECTION_EXISTS', 'This account is already connected.'); throw error; }
    return connectionDto(this.getConnection(userId, id));
  }
  listConnections(userId) { return this.db.prepare('SELECT * FROM connections WHERE user_id=? ORDER BY created_at,id').all(userId).map(connectionDto); }
  getConnection(userId, id) {
    const row = this.db.prepare('SELECT * FROM connections WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw notFound(); return row;
  }
  updateCredentials(userId, id, { accountKey, encryptedCredentials, label }) {
    return this.transaction(() => {
      const row = this.getConnection(userId, id);
      if (row.account_key !== accountKey) throw new ServiceError(400, 'ACCOUNT_CHANGED', 'Create a new connection to use a different job-site account.');
      if (this.db.prepare(`SELECT id FROM runs WHERE connection_id=? AND status IN ${active}`).get(id)) throw new ServiceError(409, 'CONNECTION_BUSY', 'Stop the connection operation before changing credentials.');
      this.db.prepare("UPDATE connections SET encrypted_credentials=?,label=?,auth_status='not_authenticated',updated_at=? WHERE id=?").run(encryptedCredentials, label, now(), id);
      return connectionDto(this.getConnection(userId, id));
    });
  }
  connectionStatus(id, status) { this.db.prepare('UPDATE connections SET auth_status=?,updated_at=? WHERE id=?').run(status, now(), id); }
  enqueue(userId, connectionId, kind, options, parentRunId = null) {
    return this.transaction(() => {
      const connection = this.getConnection(userId, connectionId);
      if (parentRunId) {
        const parent = this.getRunRow(userId, parentRunId);
        if (!['stopped','failed','attention_required','interrupted'].includes(parent.status) || parent.connection_id !== connectionId) throw new ServiceError(409, 'NOT_RETRYABLE', 'Only stopped, failed, interrupted or attention-required runs can be retried.');
      }
      const existing = this.db.prepare(`SELECT id FROM runs WHERE connection_id=? AND status IN ${active}`).get(connectionId);
      if (existing) throw new ServiceError(409, 'RUN_EXISTS', 'A run is already queued or active for this connection.', { runId: existing.id });
      const id = randomUUID();
      this.db.prepare("INSERT INTO runs(id,user_id,connection_id,site,account_key,kind,transport,options_json,queued_at,status,parent_run_id) VALUES(?,?,?,?,?,?,?,?,?,'queued',?)")
        .run(id, userId, connectionId, connection.site, connection.account_key, kind, options.transport, JSON.stringify(options), now(), parentRunId);
      this.addEvent(id, 'queued', {});
      return this.getRun(userId, id);
    });
  }
  getRunRow(userId, id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(id, userId);
    if (!row) throw notFound(); return row;
  }
  getRun(userId, id) { return runDto(this.getRunRow(userId, id)); }
  listRuns(userId, { cursor, limit = 20, connectionId, status } = {}) {
    // Queue timestamps are ISO strings; the cursor carries the unique last ID and timestamp.
    let before = null;
    if (cursor) {
      try { before = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new ServiceError(400, 'INVALID_CURSOR', 'Invalid run cursor.'); }
      if (typeof before?.time !== 'string' || typeof before?.id !== 'string') throw new ServiceError(400, 'INVALID_CURSOR', 'Invalid run cursor.');
    }
    const clauses = ['user_id=?']; const params = [userId];
    if (connectionId) { clauses.push('connection_id=?'); params.push(connectionId); }
    if (status === 'active') clauses.push(`status IN ${active}`);
    else if (status) { clauses.push('status=?'); params.push(status); }
    if (before) { clauses.push('(queued_at<? OR (queued_at=? AND id<?))'); params.push(before.time, before.time, before.id); }
    const rows = this.db.prepare(`SELECT * FROM runs WHERE ${clauses.join(' AND ')} ORDER BY queued_at DESC,id DESC LIMIT ?`).all(...params, limit + 1);
    const more = rows.length > limit; const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items: items.map(runDto), nextCursor: more ? Buffer.from(JSON.stringify({ time: last.queued_at, id: last.id })).toString('base64url') : null };
  }
  stopRun(userId, id) {
    return this.transaction(() => {
      const row = this.getRunRow(userId, id);
      if (row.status === 'queued') this.db.prepare("UPDATE runs SET status='stopped',ended_at=?,stop_requested_at=? WHERE id=?").run(now(), now(), id);
      else if (['starting','running'].includes(row.status)) this.db.prepare("UPDATE runs SET status='stop_requested',stop_requested_at=? WHERE id=?").run(now(), id);
      if (['queued','starting','running'].includes(row.status)) this.addEvent(id, 'stop_requested', {});
      return this.getRun(userId, id);
    });
  }
  claim(supervisorId, concurrency) {
    return this.transaction(() => {
      this.reapDeadCli();
      const count = this.db.prepare(`SELECT count(*) AS n FROM runs WHERE status IN ${executing}`).get().n;
      if (count >= concurrency) return null;
      const row = this.db.prepare(`SELECT r.* FROM runs r WHERE r.status='queued' AND r.available_at<=?
        AND NOT EXISTS(SELECT 1 FROM runs x WHERE x.user_id=r.user_id AND x.status IN ${executing})
        AND NOT EXISTS(SELECT 1 FROM runs x WHERE x.site=r.site AND x.account_key=r.account_key AND x.status IN ${executing})
        ORDER BY r.queued_at,r.id LIMIT 1`).get(Date.now());
      if (!row) return null;
      this.db.prepare("UPDATE runs SET status='starting',supervisor_id=?,started_at=?,heartbeat_at=?,phase='starting' WHERE id=?").run(supervisorId, now(), now(), row.id);
      this.addEvent(row.id, 'starting', {});
      return { ...row, supervisor_id: supervisorId, ...this.getConnection(row.user_id, row.connection_id), id: row.id, connection_id: row.connection_id };
    });
  }
  workerPid(id, supervisorId, pid) { this.db.prepare("UPDATE runs SET pid=? WHERE id=? AND supervisor_id=? AND status IN ('starting','stop_requested')").run(pid, id, supervisorId); }
  workerStarted(id) { this.db.prepare("UPDATE runs SET status=CASE WHEN status='stop_requested' THEN status ELSE 'running' END,heartbeat_at=? WHERE id=? AND status IN ('starting','stop_requested')").run(now(), id); }
  control(id) { return this.db.prepare('SELECT status,stop_requested_at,heartbeat_at FROM runs WHERE id=?').get(id); }
  progress(id, phase, counters) {
    this.db.prepare(`UPDATE runs SET phase=?,counters_json=?,heartbeat_at=? WHERE id=? AND status IN ${executing}`).run(phase, JSON.stringify(counters), now(), id);
  }
  defer(id) {
    if (this.control(id)?.status === 'stop_requested') { this.endRun(id, 'stopped'); return; }
    this.db.prepare("UPDATE runs SET status='queued',started_at=NULL,supervisor_id=NULL,pid=NULL,available_at=? WHERE id=? AND status='starting'").run(Date.now() + 5000, id);
  }
  endRun(id, status, error = null, errorCode = null, forced = false) {
    const result = this.db.prepare(`UPDATE runs SET status=?,ended_at=?,error=?,error_code=?,forced=? WHERE id=? AND status IN ${active}`).run(status, now(), error, errorCode, Number(forced), id);
    if (result.changes) this.addEvent(id, status, { forced, errorCode });
    else if (errorCode) this.db.prepare("UPDATE runs SET error_code=COALESCE(error_code,?) WHERE id=? AND status IN ('failed','attention_required')").run(errorCode, id);
  }
  recover() {
    const rows = this.db.prepare(`SELECT id FROM runs WHERE supervisor_id IS NOT NULL AND status IN ${executing}`).all();
    this.transaction(() => { this.reapDeadCli(); for (const row of rows) this.endRun(row.id, 'interrupted', 'Service or worker exited before completion.', 'WORKER_INTERRUPTED'); });
    return rows.length;
  }
  reapDeadCli() {
    for (const row of this.db.prepare(`SELECT id,pid FROM runs WHERE supervisor_id IS NULL AND pid IS NOT NULL AND status IN ${executing}`).all()) {
      try { process.kill(row.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') this.endRun(row.id, 'interrupted', 'CLI process exited before completion.', 'CLI_INTERRUPTED'); }
    }
  }
  staleRuns(supervisorId, before) { return this.db.prepare(`SELECT id FROM runs WHERE supervisor_id=? AND status IN ${executing} AND heartbeat_at<?`).all(supervisorId, before).map(row => row.id); }
  addEvent(runId, type, payload) {
    this.db.prepare('INSERT INTO run_events(run_id,user_id,type,payload_json,created_at) SELECT id,user_id,?,?,? FROM runs WHERE id=?').run(type, JSON.stringify(payload), now(), runId);
  }
  events(userId, runId, { after = 0, limit = 50 } = {}) {
    this.getRunRow(userId, runId);
    const rows = this.db.prepare('SELECT id,type,payload_json,created_at FROM run_events WHERE user_id=? AND run_id=? AND id>? ORDER BY id LIMIT ?').all(userId, runId, after, limit);
    return { items: rows.map(row => ({ id: row.id, type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at })), nextCursor: rows.at(-1)?.id ?? after };
  }
  listJobs(userId, { limit = 20, includeDetails = false, includeApplicationUrl = false, ...filters } = {}) {
    const { where, params } = jobWhere(userId, filters);
    const sorting = listSorting('jobs', jobSortFields, filters);
    const rows = this.db.prepare(`SELECT j.id,j.connection_id,j.company_id,c.name AS company_name,j.site,j.source_job_id,j.url,j.title,j.company,j.first_seen_at,j.last_scraped_at,j.assigned_at,j.posted_date,j.match_total_score,j.match_skill_score,j.match_industry_score,p.state,p.website_status,${sorting.expression} AS sort_value${includeDetails ? ',j.details_json' : ''}${includeApplicationUrl ? ",json_extract(j.details_json,'$.applicationUrl') AS application_url" : ''} FROM jobs j LEFT JOIN companies c ON c.id=j.company_id AND c.user_id=j.user_id LEFT JOIN connections connection ON connection.id=j.connection_id AND connection.user_id=j.user_id LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE ${where} AND ${sorting.where} ORDER BY ${sorting.order} LIMIT ?`).all(...params, ...sorting.params, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ ...jobDto(row), ...(includeDetails ? { details: JSON.parse(row.details_json) } : {}), ...(includeApplicationUrl ? { applicationUrl: row.application_url } : {}) }));
    return { items, nextCursor: rows.length > limit ? sorting.cursor(rows[limit - 1]) : null };
  }
  assignJobs(userId, filters = {}) {
    const { where, params } = jobWhere(userId, { ...filters, availableOnly: true });
    const result = this.db.prepare(`UPDATE jobs SET assigned_at=? WHERE id IN (SELECT j.id FROM jobs j LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE ${where})`).run(now(), ...params);
    return { assignedCount: Number(result.changes) };
  }
  jobDetail(userId, id, includeRaw = false) {
    const row = this.db.prepare('SELECT j.*,c.name AS company_name,p.state,p.website_status FROM jobs j LEFT JOIN companies c ON c.id=j.company_id AND c.user_id=j.user_id LEFT JOIN job_processing p ON p.job_id=j.id AND p.account_key=j.account_key WHERE j.id=? AND j.user_id=?').get(id, userId);
    if (!row) throw notFound();
    return { ...jobDto(row), details: JSON.parse(row.details_json), ...(includeRaw ? { raw: row.raw_json ? JSON.parse(row.raw_json) : null } : {}) };
  }
  claimLegacy(userId, imports) {
    return this.transaction(() => imports.map(input => {
      const existing = this.db.prepare('SELECT * FROM connections WHERE user_id=? AND site=? AND account_key=?').get(userId, input.site, input.accountKey);
      const connection = existing ? connectionDto(existing) : this.createConnection({ ...input, userId, cliDefault: true });
      if (existing) this.db.prepare('UPDATE connections SET cli_default=1 WHERE id=?').run(existing.id);
      const scope = `legacy:${input.site}:${input.accountKey}`;
      this.db.prepare('UPDATE jobs SET scope_key=?,connection_id=?,user_id=? WHERE scope_key=?').run(connection.id, connection.id, userId, scope);
      this.db.prepare('UPDATE runs SET connection_id=?,user_id=? WHERE site=? AND account_key=? AND user_id IS NULL').run(connection.id, userId, input.site, input.accountKey);
      return { ...connection, accountKey: input.accountKey };
    }));
  }
}
function jobDto(row) { return { id: row.id, connectionId: row.connection_id, companyId: row.company_id ?? null, companyName: row.company_name ?? null, site: row.site, sourceJobId: row.source_job_id, url: row.url, title: row.title, company: row.company, firstSeenAt: row.first_seen_at, lastScrapedAt: row.last_scraped_at, assignedAt: row.assigned_at ?? null, processingState: row.state ?? null, websiteStatus: row.website_status ?? null, postedDate:row.posted_date??null, matchingScores:{total:row.match_total_score??null,skill:row.match_skill_score??null,industry:row.match_industry_score??null} }; }

export const rpcMethods = ['ping','createUser','listUsers','findUser','createSession','sessionUser','deleteSession','createConnection','listConnections','getConnection','updateCredentials','enqueue','getRun','listRuns','stopRun','claim','workerPid','control','defer','endRun','recover','staleRuns','events','listJobs','assignJobs','jobDetail','addEvent',...companyRpcMethods];
