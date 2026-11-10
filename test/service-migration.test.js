import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceStore } from '../src/storage/service-store.js';
import { Store } from '../src/storage/database.js';
import { migrate } from '../src/storage/migrations.js';
import { removeFilterSchema } from './helpers/filter-schema.js';

const removeCompanySchema = removeFilterSchema+'DROP TRIGGER job_company_owner_update; DROP TRIGGER job_company_owner_insert; DROP INDEX owned_company_jobs; ALTER TABLE jobs DROP COLUMN company_id; DROP TABLE company_identifiers; DROP TABLE company_syncs; DROP TABLE companies;';

test('legacy migration preserves JSON, account-specific states and CLI access while withholding unclaimed data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-service-migrate-'));
  const path = join(directory, 'legacy.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE jobs(id INTEGER PRIMARY KEY,site TEXT,source_job_id TEXT,url TEXT,title TEXT,company TEXT,details_json TEXT,raw_json TEXT,first_seen_at TEXT,last_scraped_at TEXT,UNIQUE(site,source_job_id));
      CREATE TABLE job_processing(job_id INTEGER,account_key TEXT,state TEXT,website_status TEXT,last_error TEXT,updated_at TEXT,PRIMARY KEY(job_id,account_key));
      CREATE TABLE runs(id TEXT PRIMARY KEY,site TEXT,account_key TEXT,transport TEXT,started_at TEXT,ended_at TEXT,status TEXT,counters_json TEXT,error TEXT);`);
    const details = { description: { text: 'Long migrated information '.repeat(10000) }, nested: { future: [1, 2, 3] } };
    legacy.prepare('INSERT INTO jobs VALUES(1,?,?,?,?,?,?,?,?,?)').run('jobright', 'source', 'https://fixture.test/job', 'Old job', 'Company', JSON.stringify(details), '{"preserved":true}', '2026-11-01', '2026-11-01');
    legacy.prepare('INSERT INTO job_processing VALUES(?,?,?,?,?,?)').run(1, 'account-a', 'mark_pending', null, null, '2026-11-01');
    legacy.prepare('INSERT INTO job_processing VALUES(?,?,?,?,?,?)').run(1, 'account-b', 'saved', null, null, '2026-11-01');
    legacy.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run('old', 'jobright', 'account-a', 'browser', '2026-11-01', null, 'running', '{"saved":1}', null);
    legacy.close();
    store = new ServiceStore(path);
    await access(path + '.pre-service.bak');
    const admin = store.createUser({ email: 'admin@fixture.test', passwordHash: 'test', role: 'admin', bootstrap: true });
    const bob = store.createUser({ email: 'bob@fixture.test', passwordHash: 'test' });
    assert.equal(store.listJobs(admin.id).items.length, 0);
    const [connection] = store.claimLegacy(admin.id, [{ site: 'jobright', accountKey: 'account-a', label: 'Legacy account', encryptedCredentials: '{}' }]);
    assert.equal(store.listJobs(admin.id).items[0].id, 1);
    assert.deepEqual(store.jobDetail(admin.id, 1).details, details);
    assert.equal(store.state('jobright', 'account-a', 'source').state, 'mark_pending');
    assert.equal(store.state('jobright', 'account-b', 'source').state, 'saved');
    assert.equal(store.getRun(admin.id, 'old').status, 'interrupted');
    assert.equal(store.listJobs(bob.id).items.length, 0);
    assert.throws(() => store.jobDetail(bob.id, 1), /not found/);
    const other = store.createConnection({ userId: bob.id, site: 'jobright', accountKey: 'account-a', label: 'Other connection', encryptedCredentials: '{}' });
    const scoped = new Store(path, { userId: bob.id, connectionId: other.id });
    const id = scoped.saveJob('jobright', 'account-a', { id: 'source', url: 'https://fixture.test/job', title: 'Other personalized title', details });
    assert.notEqual(id, 1); scoped.close();
    assert.equal(store.jobDetail(admin.id, 1).title, 'Old job');
    assert.equal(store.listJobs(bob.id).items.length, 1);
    assert.equal(store.claimLegacy(admin.id, [{ site: 'jobright', accountKey: 'account-a', label: 'Legacy', encryptedCredentials: '{}' }])[0].id, connection.id);
    store.close(); store = new Store(path);
    assert.equal(store.state('jobright', 'account-a', 'source').state, 'mark_pending');
    assert.equal(store.saveJob('jobright', 'account-a', { id: 'source', title: 'CLI update', url: 'https://fixture.test/job', details }), 1);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('version-one databases gain persistent assignment without changing content or collection processing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-assignment-migrate-'));
  const path = join(directory, 'jobs.sqlite');
  let store;
  try {
    store = new ServiceStore(path);
    const user = store.createUser({ email: 'alice@fixture.test', passwordHash: 'test' });
    store.createConnection({ userId: user.id, site: 'jobright', accountKey: 'a', label: 'Account', encryptedCredentials: '{}', cliDefault: true });
    const job = { id: 'persistent', title: 'Engineer', url: 'https://example.test/job', details: { description: { text: 'Retained details.' } } };
    const id = store.saveJob('jobright', 'a', job);
    store.transition(id, 'a', 'mark_pending');
    store.db.exec(removeCompanySchema + 'ALTER TABLE jobs DROP COLUMN assigned_at; PRAGMA user_version=1');
    store.close();
    store = new ServiceStore(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(store.jobDetail(user.id, id).assignedAt, null);
    assert.deepEqual(store.jobDetail(user.id, id).details, job.details);
    assert.equal(store.assignJobs(user.id).assignedCount, 1);
    const assignedAt = store.jobDetail(user.id, id).assignedAt;
    store.close();
    store = new ServiceStore(path);
    assert.equal(store.saveJob('jobright', 'a', { ...job, title: 'Refreshed title' }), id);
    assert.equal(store.jobDetail(user.id, id).assignedAt, assignedAt);
    assert.equal(store.state('jobright', 'a', job.id).state, 'mark_pending');
    store.transition(id, 'a', 'mark_confirmed', 'applied');
    assert.equal(store.jobDetail(user.id, id).assignedAt, assignedAt);
    assert.equal(store.jobDetail(user.id, id).processingState, 'mark_confirmed');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('version-two migration adds empty company storage and retains assignment, raw JSON and pending writes',()=>{
  // Build the prior schema in memory without modifying a real database.
  const store=new ServiceStore(':memory:');
  try {
    const user=store.createUser({email:'migration@fixture.test',passwordHash:'fixture'});
    store.createConnection({userId:user.id,site:'jobright',accountKey:'fixture',label:'Fixture',encryptedCredentials:'{}',cliDefault:true});
    const job={id:'v2',title:'Engineer',company:'Acme',url:'https://fixture.test/job',details:{description:{text:'Full content. '.repeat(10000)},company:{companyName:'Acme'}},raw:{retained:true}};
    const id=store.saveJob('jobright','fixture',job);store.transition(id,'fixture','mark_pending');store.assignJobs(user.id);
    const assigned=store.jobDetail(user.id,id).assignedAt;
    store.db.exec(removeCompanySchema+'PRAGMA user_version=2');
    // Exercise the actual migration against the existing connection.
    migrate(store.db,':memory:');
    const result=store.jobDetail(user.id,id,true);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,5);
    assert.equal(result.companyId,null);assert.equal(result.assignedAt,assigned);assert.equal(result.processingState,'mark_pending');
    assert.deepEqual(result.details,job.details);assert.deepEqual(result.raw,job.raw);
    assert.equal(store.listCompanies(user.id).items.length,0);assert.equal(store.latestCompanySync(user.id),null);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {store.close();}
});
