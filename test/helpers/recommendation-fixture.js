import assert from 'node:assert/strict';
import { aiFixture } from './ai-fixture.js';
import { serviceFixture } from './service-fixture.js';
import { ServiceStore } from '../../src/storage/service-store.js';
import { accountKey } from '../../src/core/security.js';

export function classificationInput({body}) {
    const system=body.instructions ?? body.system ?? body.systemInstruction?.parts[0].text ?? body.messages?.find(message=>message.role==='system')?.content;
    const titles=JSON.parse(system.split('Available specializations:\n')[1].split('\n')[0]);
    const input=JSON.parse(body.input ?? body.contents?.[0].parts[0].text ?? body.messages.find(message=>message.role==='user').content);
    return {titles,jobs:input.jobs};
}
export async function recommendationFixture(options={}) {
  let choose=args=>{
    const {titles,jobs}=classificationInput(args);
    return {results:jobs.map(job=>({jobId:job.jobId,specializationId:job.title.includes('unmatched') ? null : job.title.includes('invalid') ? 'invented-id' : titles[0].id}))};
  };
  const source=await aiFixture({jsonOutput:args=>choose(args)});
  const f=await serviceFixture({ai:source.options,...options});
  const admin=await f.login('admin'),alice=await f.login('alice');
  const one=await f.connect(admin,'fixture','one@provider.test'),two=await f.connect(admin,'fixture','two@provider.test'),blank=await f.connect(admin,'fixture','blank@provider.test'),foreign=await f.connect(alice,'fixture','foreign@provider.test');
  async function command(method,path,body,status=200,cookie=admin) {
    const response=await f.request(method,'/api/v1'+path,body,cookie);
    assert.equal(response.statusCode,status,response.body);return response.json();
  }
  const first=await command('POST',`/connections/${one.id}/titles`,{title:'Platform Engineer'},201),second=await command('POST',`/connections/${one.id}/titles`,{title:'SRE'},201),otherTitle=await command('POST',`/connections/${two.id}/titles`,{title:'DevOps Engineer'},201);
  async function configure(profile,provider='openai',prompt='Private rule: choose the best role.') {
    return command('PATCH',`/connections/${profile.id}`,{specializationPrompt:prompt,specializationModel:{provider,id:`${provider}-fixture`}});
  }
  await configure(one);await configure(two,'claude');
  function save(profile,id,extra={}) {
    const writer=new ServiceStore(f.config.dbPath,{userId:profile.id===foreign.id?f.users.alice.id:f.users.admin.id,connectionId:profile.id});
    try{return writer.saveJob('jobright',accountKey(profile.label),{id,title:`Cloud Engineer ${id}`,company:'Company',url:'https://fixture.test/jobs/'+id,
      raw:{token:'do-not-send-raw'},...extra,details:{description:{text:'Complete description'},responsibilities:['Build systems'],qualifications:{required:['Operations'],preferred:['Linux']},skills:['Terraform'],extra:{email:'do-not-send-account'},...extra.details}});}
    finally{writer.close();}
  }
  async function wait(id,statuses=['completed'],timeout=4000) {
    const deadline=Date.now()+timeout;let result;
    while(Date.now()<deadline){result=await command('GET',`/ai/recommendations/${id}`);if(statuses.includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error('Recommendation did not finish: '+JSON.stringify(result));
  }
  return {...f,source,admin,alice,one,two,blank,foreign,first,second,otherTitle,configure,command,save,wait,
    choose:callback=>{choose=callback;},
    async start(filters={}) {return command('POST','/ai/recommendations',{filters},202);},
    async run(filters={}) {await f.app.recommendations.start();const task=await this.start(filters);return wait(task.id);},
    async close(){await f.close();await source.close();}};
}
