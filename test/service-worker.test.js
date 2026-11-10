import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir,writeFile,utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceFixture, waitForRun } from './helpers/service-fixture.js';
import { startFixtureServer } from './helpers/fixture-server.js';
import { accountKey } from '../src/core/security.js';

test('real background worker authenticates and collects through Jobright plugin against a local fixture', async () => {
  const source = await startFixtureServer({ ids: Array.from({ length: 25 }, (_, index) => `job${index}`) });
  source.delaySignIn(800);
  const f = await serviceFixture({ supervise: true, workerModule: undefined, stopGraceMs: 5000, workerSettings: { baseUrl: source.baseUrl, intervalMs: 0, pollMs: 50, timeout: 10000 } });
  try {
    const alice = await f.login('alice');
    const connection = await f.connect(alice, 'fixture-password', 'fixture@example.test');
    const authentication = await f.request('POST', `/api/v1/connections/${connection.id}/authenticate`, {}, alice);
    assert.equal(authentication.statusCode, 202);
    assert.equal(authentication.json().status, 'queued');
    assert.equal((await f.request('GET', '/health')).statusCode, 200);
    await waitForRun(f, alice, authentication.json().id, ['completed'], 20000);
    assert.equal(source.requests.filter(request => request.path === '/fixture-login').length, 1);
    assert.equal((await f.request('GET', '/api/v1/connections', undefined, alice)).json()[0].authStatus, 'ready');
    await access(join(f.directory, 'sessions', f.users.alice.id, connection.id, 'session.json'));
    const response = await f.request('POST', '/api/v1/runs', { connectionId: connection.id, transport: 'api', limit: 25 }, alice);
    assert.equal(response.statusCode, 202);
    const complete = await waitForRun(f, alice, response.json().id, ['completed'], 20000);
    assert.equal(complete.counters.confirmed, 25);
    assert.equal(source.applied.size, 25);
    const jobs = (await f.request('GET', '/api/v1/jobs', undefined, alice)).json().items;
    assert.equal(jobs[0].processingState, 'mark_confirmed');
    const events = (await f.request('GET', `/api/v1/runs/${response.json().id}/events`, undefined, alice)).json().items;
    assert.ok(events.some(event => event.type === 'job_saved'));
    assert.ok(!JSON.stringify(events).includes('fixture-password'));
    const continuous = (await f.request('POST', '/api/v1/runs', { connectionId: connection.id, transport: 'api', readOnly: true }, alice)).json();
    await waitForRun(f, alice, continuous.id, ['running'], 20000);
    const entry = f.app.supervisor.children.get(continuous.id);
    entry.child.disconnect();
    const interrupted = await waitForRun(f, alice, continuous.id, ['interrupted'], 20000);
    assert.equal(interrupted.error.code, 'SUPERVISOR_DISCONNECTED');
  } finally { await f.close(); await source.close(); }
});

test('managed transports collect despite stalled DOMContentLoaded and Stop interrupts held authentication',async()=>{
  const source=await startFixtureServer();source.stallAssets();
  const f=await serviceFixture({supervise:true,workerModule:undefined,stopGraceMs:5000,workerSettings:{baseUrl:source.baseUrl,intervalMs:0,pollMs:50,timeout:60000}});
  try {
    const cookie=await f.login('alice'),connection=await f.connect(cookie,'fixture-password','fixture@example.test');
    for(const transport of ['api','browser']){
      const response=await f.request('POST','/api/v1/runs',{connectionId:connection.id,transport,readOnly:true,limit:1},cookie);assert.equal(response.statusCode,202);
      const complete=await waitForRun(f,cookie,response.json().id,['completed'],15000);assert.equal(complete.counters.saved,1);assert.equal(complete.counters.confirmed,0);
    }
    assert.equal(source.applied.size,0);
    source.holdRecommendations();const before=source.requests.filter(request=>request.path==='/jobs/recommend').length;
    const run=(await f.request('POST','/api/v1/runs',{connectionId:connection.id,transport:'api',readOnly:true},cookie)).json();
    await waitForRun(f,cookie,run.id,['running'],5000);
    const deadline=Date.now()+5000;while(source.requests.filter(request=>request.path==='/jobs/recommend').length===before&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(source.requests.filter(request=>request.path==='/jobs/recommend').length>before);
    const started=Date.now();assert.equal((await f.request('GET','/health')).statusCode,200);assert.equal((await f.request('GET','/api/v1/jobs',undefined,cookie)).statusCode,200);
    assert.equal((await f.request('POST',`/api/v1/runs/${run.id}/stop`,undefined,cookie)).statusCode,202);
    const stopped=await waitForRun(f,cookie,run.id,['stopped'],4000);assert.ok(Date.now()-started<4000);assert.equal(stopped.forced,false);assert.equal(stopped.error,null);assert.equal(source.applied.size,0);
  }finally{await f.close();await source.close();}
});

test('real authentication worker safely reclaims a legacy lock whose PID has been reused',async()=>{
  const source=await startFixtureServer();
  const f=await serviceFixture({supervise:true,workerModule:undefined,stopGraceMs:5000,workerSettings:{baseUrl:source.baseUrl,intervalMs:0,pollMs:50,timeout:10000}});
  try{
    const cookie=await f.login('alice'),email='fixture@example.test',connection=await f.connect(cookie,'fixture-password',email);
    const path=join(f.directory,'locks',`jobright-${accountKey(email)}.lock`);await mkdir(join(f.directory,'locks'),{recursive:true});
    await writeFile(path,JSON.stringify({pid:process.pid,token:'old-legacy-owner'}));const old=new Date('2010-01-01T00:00:00Z');await utimes(path,old,old);
    const response=await f.request('POST',`/api/v1/connections/${connection.id}/authenticate`,{},cookie);assert.equal(response.statusCode,202);
    const run=await waitForRun(f,cookie,response.json().id,['completed'],20000);assert.equal(run.error,null);assert.equal(run.forced,false);
    const deadline=Date.now()+3000;while(f.app.supervisor.children.has(run.id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(access(path));await assert.rejects(access(path+'.reclaim'));
    assert.equal(source.applied.size,0);process.kill(process.pid,0);
  }finally{await f.close();await source.close();}
});
