import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RecommendationCoordinator } from '../src/service/recommendations.js';
import { ServiceStore } from '../src/storage/service-store.js';
import { migrate } from '../src/storage/migrations.js';
import { removeRecommendationSchema } from './helpers/profile-schema.js';
import { hashToken } from '../src/service/crypto.js';
import { accountKey } from '../src/core/security.js';
import { recommendationFixture, classificationInput } from './helpers/recommendation-fixture.js';

test('profile AI settings are partial, nullable, strict, admin-only and owner scoped',async()=>{
  const f=await recommendationFixture();try{
    const path=`/connections/${f.one.id}`;
    await f.command('PATCH',path,{personName:'Daniel Zhang'});
    const result=await f.configure(f.one,'gemini','规则'.repeat(4000));
    assert.equal(result.personName,'Daniel Zhang');assert.equal(result.specializationPrompt.length,8000);
    assert.deepEqual(result.specializationModel,{provider:'gemini',id:'gemini-fixture'});
    for(const body of [{},{specializationPrompt:false},{specializationPrompt:'x'.repeat(8001)},{specializationModel:{provider:'other',id:'id'}},{specializationModel:{provider:'openai',id:'unknown'}},{specializationModel:{provider:'openai',id:'openai-text-only'}}])await f.command('PATCH',path,body,400);
    await f.command('PATCH',`/connections/${f.foreign.id}`,{specializationPrompt:'rule'},403,f.alice);
    await f.command('PATCH',`/connections/${f.foreign.id}`,{personName:'No'},404);
    assert.equal((await f.request('PATCH','/api/v1'+path,{specializationPrompt:'rule'},f.admin,'https://untrusted.test')).statusCode,403);
    const cleared=await f.command('PATCH',path,{specializationPrompt:null,specializationModel:null});
    assert.equal(cleared.specializationPrompt,null);assert.equal(cleared.specializationModel,null);assert.equal(cleared.personName,'Daniel Zhang');
    assert.equal(f.source.requests.length,0);
  }finally{await f.close();}
});

test('recommendations snapshot every filtered page, replace selections, preserve no-match and tracking, and skip ineligible profiles',async()=>{
  const f=await recommendationFixture();try{
    const old=f.save(f.one,'old'),same=f.save(f.one,'same'),unmatched=f.save(f.one,'unmatched');
    f.save(f.two,'second');f.save(f.blank,'blank');f.save(f.foreign,'foreign');
    await f.command('PATCH',`/jobs/${old}`,{preferredTitleId:f.second.id});
    await f.command('PATCH',`/jobs/${same}`,{preferredTitleId:f.first.id});
    await f.command('PATCH',`/jobs/${unmatched}`,{preferredTitleId:f.second.id});
    const before=await f.command('GET',`/jobs/${old}`);
    const run=await f.start();
    f.save(f.one,'after-snapshot');
    await f.app.recommendations.start();const done=await f.wait(run.id);
    assert.equal(done.total,5);assert.equal(done.processed,5);assert.equal(done.updated,2);assert.equal(done.unchanged,1);assert.equal(done.unmatched,1);assert.equal(done.failed,0);assert.equal(done.skipped,1);
    assert.ok(done.issues.some(issue=>issue.code==='NO_PROMPT'));
    const after=await f.command('GET',`/jobs/${old}`);
    assert.equal(after.preferredTitleId,f.first.id);assert.equal(after.title,before.title);assert.equal(after.assignedAt,before.assignedAt);assert.equal(after.processingState,before.processingState);
    assert.equal((await f.command('GET',`/jobs/${unmatched}`)).preferredTitleId,f.second.id);
    assert.equal(f.source.requests.length,2);
    const wire=JSON.stringify(f.source.requests.map(request=>request.body));
    assert.ok(!wire.includes('do-not-send-raw'));assert.ok(!wire.includes('do-not-send-account'));assert.ok(!wire.includes(f.one.label));assert.ok(wire.includes('Complete description'));assert.ok(wire.includes('Terraform'));
    const db=new DatabaseSync(f.config.dbPath,{readOnly:true});try{
      const history=JSON.stringify(db.prepare('SELECT * FROM ai_recommendations').all())+JSON.stringify(db.prepare('SELECT * FROM ai_recommendation_jobs').all());
      assert.ok(!history.includes('Private rule'));assert.ok(!history.includes('Complete description'));assert.ok(!JSON.stringify(f.source.logs).includes('Private rule'));
    }finally{db.close();}
  }finally{await f.close();}
});

test('every provider categorizes through the shared JSON contract with its exact configured model',async()=>{
  const f=await recommendationFixture();try{
    const ids=Array.from({length:3},(_,index)=>f.save(f.one,'provider-'+index));
    for(const provider of ['openai','gemini','deepseek','claude']){
      await f.configure(f.one,provider);
      const result=await f.run({connectionId:f.one.id});assert.equal(result.processed,3);assert.equal(result.failed,0);
      assert.equal(f.source.requests.at(-1).provider,provider);
      assert.equal(classificationInput(f.source.requests.at(-1)).jobs.length,3);
      for(const id of ids) assert.equal((await f.command('GET',`/jobs/${id}`)).preferredTitleId,f.first.id);
    }
  }finally{await f.close();}
});

test('queue conflicts, ownership, Origin, filters and idempotent queued cancellation are enforced',async()=>{
  const f=await recommendationFixture();try{
    f.save(f.one,'one');f.save(f.two,'two');
    const run=await f.start({connectionId:f.one.id,preferredTitleId:'unselected'});assert.equal(run.total,1);
    const duplicate=await f.command('POST','/ai/recommendations',{filters:{}},409);assert.equal(duplicate.error.details.recommendationId,run.id);
    await f.command('GET',`/ai/recommendations/${run.id}`,undefined,403,f.alice);
    await f.command('POST','/ai/recommendations',{filters:{}},403,f.alice);
    assert.equal((await f.request('POST','/api/v1/ai/recommendations',{filters:{}},f.admin,'https://untrusted.test')).statusCode,403);
    for(let i=0;i<2;i++)assert.equal((await f.command('POST',`/ai/recommendations/${run.id}/stop`)).status,'stopped');
    assert.equal((await f.command('GET','/ai/recommendations/latest')).id,run.id);
    for(const filters of [{page:2},{sortBy:'title'},{totalMatchMin:70,totalMatchMax:10}])await f.command('POST','/ai/recommendations',{filters},400);
    assert.equal(f.source.requests.length,0);
  }finally{await f.close();}
});

test('pending generation leaves APIs responsive and cannot overwrite a manual edit or archived title',async()=>{
  const f=await recommendationFixture();try{
    const id=f.save(f.one,'held');f.source.mode('openai','held');await f.app.recommendations.start();
    const run=await f.start({connectionId:f.one.id});await f.source.waitFor(1);
    assert.equal((await f.request('GET','/health')).statusCode,200);await f.command('GET','/jobs');
    await f.command('PATCH',`/jobs/${id}`,{preferredTitleId:f.second.id});
    await f.command('POST',`/ai/recommendations/${run.id}/stop`);const stopped=await f.wait(run.id,['stopped']);assert.equal(stopped.updated,0);
    assert.equal((await f.command('GET',`/jobs/${id}`)).preferredTitleId,f.second.id);
    // Commit a late result directly through the same DB boundary: revision and archive checks still apply.
    await f.app.recommendations.close(); // leave no live generation; terminalize/recover below
    const store=new ServiceStore(f.config.dbPath);try{
      store.recoverRecommendations();
      const task=store.enqueueRecommendation(f.users.admin.id,{connectionId:f.one.id});store.claimRecommendation();store.nextRecommendationJob(f.users.admin.id,task.id);
      store.setPreferredTitle(f.users.admin.id,id,f.first.id);store.setPreferredTitle(f.users.admin.id,id,f.second.id);
      store.finishRecommendationItem(f.users.admin.id,task.id,id,{specializationId:f.first.id});assert.equal(store.recommendation(f.users.admin.id,task.id).skipped,1);
      store.finishRecommendation(f.users.admin.id,task.id,'completed');
      const archived=store.enqueueRecommendation(f.users.admin.id,{connectionId:f.one.id});store.claimRecommendation();store.nextRecommendationJob(f.users.admin.id,archived.id);
      store.updateProfileTitle(f.users.admin.id,f.one.id,f.first.id,{isArchived:true});store.finishRecommendationItem(f.users.admin.id,archived.id,id,{specializationId:f.first.id});
      assert.equal(store.recommendation(f.users.admin.id,archived.id).issues[0].code,'TITLE_UNAVAILABLE');
    }finally{store.close();}
  }finally{await f.close();}
});

test('capacity waiting does not dispatch duplicates, and Stop releases a waiting operation',async()=>{
  const f=await recommendationFixture();try{
    f.save(f.one,'waiting');f.source.mode('openai','held');
    const controller=new AbortController();const held=f.app.ai.generateText({model:{provider:'openai',id:'openai-fixture'},prompt:'held',signal:controller.signal},{actorId:f.users.admin.id}).catch(error=>error);
    await f.source.waitFor(1);await f.app.recommendations.start();const run=await f.start();
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.source.requests.length,1);
    await f.command('POST',`/ai/recommendations/${run.id}/stop`);await f.wait(run.id,['stopped']);assert.equal(f.source.requests.length,1);
    controller.abort();await held;
  }finally{await f.close();}
});

test('profile settings are captured once and late results respect manual selection and title archive changes',async()=>{
  const f=await recommendationFixture();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  try{
    const first=f.save(f.one,'first'),second=f.save(f.one,'second');
    f.choose(async args=>{await gate;return {results:classificationInput(args).jobs.map(job=>({jobId:job.jobId,specializationId:f.first.id}))};});
    await f.app.recommendations.start();const run=await f.start({connectionId:f.one.id});await f.source.waitFor(1);
    await f.command('PATCH',`/jobs/${first}`,{preferredTitleId:f.second.id});
    await f.configure(f.one,'claude','New rule for the next operation.');
    await f.command('PATCH',`/connections/${f.one.id}/titles/${f.first.id}`,{isArchived:true});
    release();const result=await f.wait(run.id);
    assert.equal(result.skipped,2);assert.equal(result.updated,0);
    assert.equal((await f.command('GET',`/jobs/${first}`)).preferredTitleId,f.second.id);
    assert.equal((await f.command('GET',`/jobs/${second}`)).preferredTitleId,null);
    assert.ok(f.source.requests.every(request=>request.provider==='openai'));
    assert.ok(f.source.requests.every(request=>request.body.instructions.includes('Private rule:')));
    assert.deepEqual(result.issues.map(issue=>issue.code),['SELECTION_CHANGED','TITLE_UNAVAILABLE']);
  }finally{release();await f.close();}
});

test('two administrators share generation capacity while ownership and duplicate queues remain isolated',async()=>{
  const f=await recommendationFixture();try{
    const user=await f.app.db.call('createUser',{email:'second-admin@fixture.test',passwordHash:'unused',role:'admin'});
    await f.app.db.call('createSession',{tokenHash:hashToken('second-admin'),userId:user.id,expiresAt:Date.now()+60000});
    const cookie='session=second-admin',profile=await f.connect(cookie,'fixture','other-admin@provider.test');
    await f.command('POST',`/connections/${profile.id}/titles`,{title:'SRE'},201,cookie);
    await f.command('PATCH',`/connections/${profile.id}`,{specializationPrompt:'Other rule',specializationModel:{provider:'openai',id:'openai-fixture'}},200,cookie);
    const writer=new ServiceStore(f.config.dbPath,{userId:user.id,connectionId:profile.id});try{writer.saveJob('jobright',accountKey(profile.label),{id:'other',title:'Other job',url:'https://fixture.test',details:{description:{text:'Description'}}});}finally{writer.close();}
    f.save(f.one,'one');f.source.mode('openai','held');await f.app.recommendations.start();
    const [one,two]=await Promise.all([f.start(),f.command('POST','/ai/recommendations',{filters:{}},202,cookie)]);await f.source.waitFor(2);
    assert.equal(f.source.requests.length,2);
    await f.command('GET',`/ai/recommendations/${one.id}`,undefined,404,cookie);
    await f.command('POST',`/ai/recommendations/${two.id}/stop`,undefined,404);
    const duplicate=await f.command('POST','/ai/recommendations',{filters:{}},409,cookie);assert.equal(duplicate.error.details.recommendationId,two.id);
    await f.command('POST',`/ai/recommendations/${one.id}/stop`);
    await f.command('POST',`/ai/recommendations/${two.id}/stop`,undefined,200,cookie);
    await f.wait(one.id,['stopped']);
    assert.equal((await f.command('GET',`/ai/recommendations/${two.id}`,undefined,200,cookie)).status,'stopped');
  }finally{await f.close();}
});

test('shutdown aborts outstanding classification, preserves committed selections and records interruption',async()=>{
  const f=await recommendationFixture();let release;
  const gate=new Promise(resolve=>{release=resolve;});let count=0;
  try{
    const first=Array.from({length:10},(_,index)=>f.save(f.one,'first-'+index)),two=f.save(f.one,'two');
    f.choose(async args=>{if(++count===2)await gate;return {results:classificationInput(args).jobs.map(job=>({jobId:job.jobId,specializationId:f.first.id}))};});
    await f.app.recommendations.start();const run=await f.start({connectionId:f.one.id});await f.source.waitFor(2);
    const began=Date.now();await f.app.close();assert.ok(Date.now()-began<2000);
    const db=new DatabaseSync(f.config.dbPath,{readOnly:true});try{
      const row=db.prepare('SELECT * FROM ai_recommendations WHERE id=?').get(run.id);assert.equal(row.status,'interrupted');assert.equal(row.updated,10);
      for(const id of first) assert.equal(db.prepare('SELECT preferred_title_id FROM jobs WHERE id=?').get(id).preferred_title_id,f.first.id);
      assert.equal(db.prepare('SELECT preferred_title_id FROM jobs WHERE id=?').get(two).preferred_title_id,null);
    }finally{db.close();}
  }finally{release();await f.close();}
});

test('provider authentication errors stop a run without replaying writes; individual oversized inputs fail visibly',async()=>{
  const f=await recommendationFixture();try{
    f.save(f.one,'one');f.save(f.one,'two');f.source.mode('openai','http-401');
    await f.app.recommendations.start();const run=await f.start({connectionId:f.one.id});const failed=await f.wait(run.id,['failed']);
    assert.equal(failed.errorCode,'AI_PROVIDER_AUTH');assert.equal(failed.failed,2);assert.equal(f.source.requests.length,1);
    f.source.mode('openai','success');
    f.save(f.two,'huge',{details:{description:{text:'x'.repeat(270000)}}});
    const next=await f.run({connectionId:f.two.id});assert.equal(next.failed,1);assert.equal(next.issues[0].code,'INPUT_TOO_LARGE');assert.equal(f.source.requests.length,1);
  }finally{await f.close();}
});

test('queued work survives recovery while interrupted generations are recorded and never automatically replayed',async()=>{
  const f=await recommendationFixture();try{
    const id=f.save(f.one,'restart');const run=await f.start({connectionId:f.one.id});
    const first=new RecommendationCoordinator(f.app.db,f.app.ai);await first.start();await f.wait(run.id);await first.close();
    const queued=await f.start({connectionId:f.one.id});await f.app.db.call('claimRecommendation');await f.app.db.call('nextRecommendationJob',f.users.admin.id,queued.id);
    const successor=new RecommendationCoordinator(f.app.db,f.app.ai);await successor.start();
    const interrupted=await f.wait(queued.id,['interrupted']);assert.equal(interrupted.updated,0);assert.equal(f.source.requests.length,1);
    assert.equal((await f.command('GET',`/jobs/${id}`)).preferredTitleId,f.first.id);await successor.close();
    const next=await f.start({connectionId:f.one.id});const restarted=new RecommendationCoordinator(f.app.db,f.app.ai);await restarted.start();await f.wait(next.id);await restarted.close();assert.equal(f.source.requests.length,2);
  }finally{await f.close();}
});

test('version-seven migration preserves title selections, revisions, long JSON and pending tracking; incomplete DDL rolls back',()=>{
  const store=new ServiceStore(':memory:');try{
    const user=store.createUser({email:'admin@migration.test',passwordHash:'hash',role:'admin'}),profile=store.createConnection({userId:user.id,site:'jobright',accountKey:'account',label:'account',encryptedCredentials:'encrypted',cliDefault:true});
    const title=store.createProfileTitle(user.id,profile.id,{title:'SRE'});
    const job=store.saveJob('jobright','account',{id:'source',url:'https://fixture.test',title:'Engineer',details:{description:{text:'long content '.repeat(50000)}}});
    store.setPreferredTitle(user.id,job,title.id);store.transition(job,'account','mark_pending');
    const before=store.jobDetail(user.id,job,true);
    store.db.exec(removeRecommendationSchema+'PRAGMA user_version=7; CREATE TABLE ai_recommendations(unrelated TEXT);');
    assert.throws(()=>migrate(store.db,':memory:'),/already exists/);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,7);
    assert.ok(!store.db.prepare('PRAGMA table_info(connections)').all().some(column=>column.name==='specialization_prompt'));
    store.db.exec('DROP TABLE ai_recommendations');migrate(store.db,':memory:');assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,8);
    assert.deepEqual(store.jobDetail(user.id,job,true),before);assert.equal(store.getConnection(user.id,profile.id).specialization_prompt,null);
    assert.equal(store.db.prepare('SELECT preferred_title_revision FROM jobs WHERE id=?').get(job).preferred_title_revision,0);
  }finally{store.close();}
});
