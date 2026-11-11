import { it, expect } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { alice,job,profile,mockBackend,renderApp } from './helpers.jsx';

const titleId='11111111-1111-4111-8111-111111111111';
const admin={...alice,role:'admin'};
const models=[{id:'openai',name:'OpenAI',enabled:true,models:[{id:'fixture-json',capabilities:{text:true,json:true,jsonMode:'native_schema'}},{id:'text-only',capabilities:{text:true,json:false}}]},
  {id:'claude',name:'Claude',enabled:false,models:[{id:'unavailable',capabilities:{text:true,json:true}}]}];
const task=(extra={})=>({id:'recommendation-1',status:'running',total:23,processed:1,updated:1,unchanged:0,unmatched:0,skipped:0,failed:0,errorCode:null,issues:[],...extra});
function fixture({user=admin,operation=null,conflict=false,failure=false,configured=true}={}) {
  let current={...profile,personName:'Daniel Zhang',titles:[{id:titleId,title:'SRE',isArchived:false}],specializationPrompt:null,specializationModel:null};
  let run=operation;
  const backend=mockBackend(user,{
    '/connections':({json})=>json([current]),
    '/connections/profile-a':({options,json})=>{
      if(failure)return json({error:{code:'FAILED',message:'Settings could not be saved.'}},503);
      current={...current,...JSON.parse(options.body)};return json(current);
    },
    '/ai/models':({json})=>json(configured ? models : []),
    '/ai/recommendations/latest':({json})=>json(run),
    '/ai/recommendations':({json})=>{
      if(failure)return json({error:{code:'FAILED',message:'Recommendation could not start.'}},503);
      run=task();return conflict ? json({error:{code:'RECOMMENDATION_EXISTS',message:'Already active.',details:{recommendationId:run.id}}},409) : json(run,202);
    },
    '/ai/recommendations/recommendation-1':({json})=>json(run),
    '/ai/recommendations/recommendation-1/stop':({json})=>{run=task({status:'stopped'});return json(run);},
    '/jobs':({json})=>json({items:[{...job,preferredTitleId:run?.updated?titleId:null,preferredTitle:run?.updated?'SRE':null}],nextCursor:null,total:23,page:1,pageSize:20,totalPages:2}),
  });
  return {...backend,current:()=>current,run:()=>run};
}

it('admins save and clear profile rules and explicitly select an enabled JSON-capable model',async()=>{
  const f=fixture();renderApp('/profiles');const user=userEvent.setup();
  await user.click(await screen.findByRole('button',{name:'Manage specializations for Daniel Zhang'}));
  const dialog=screen.getByRole('dialog');
  await user.type(within(dialog).getByLabelText(/Specialization rule prompt/),'Choose SRE for reliability.');
  await user.click(within(dialog).getByRole('button',{name:'Save AI settings'}));
  expect(await within(dialog).findByText('Choose an enabled provider and JSON-capable model.')).toBeInTheDocument();
  await user.selectOptions(within(dialog).getByLabelText('AI provider'),'openai');
  expect(within(dialog).queryByRole('option',{name:'text-only'})).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('option',{name:'Claude'})).not.toBeInTheDocument();
  await user.selectOptions(within(dialog).getByLabelText('AI model'),'fixture-json');
  await user.click(within(dialog).getByRole('button',{name:'Save AI settings'}));
  await within(dialog).findByText('AI settings saved.');
  expect(f.current().specializationModel).toEqual({provider:'openai',id:'fixture-json'});
  expect(f.current().specializationPrompt).toBe('Choose SRE for reliability.');
  expect(within(dialog).getByLabelText(/Specialization rule prompt/)).toHaveAttribute('maxlength','8000');
  await user.click(within(dialog).getByRole('button',{name:'Clear AI settings'}));
  await waitFor(()=>expect(f.current().specializationPrompt).toBeNull());
  expect(f.current().specializationModel).toBeNull();
});

it('AI controls are absent for ordinary users and never fetch administrator AI resources',async()=>{
  const f=fixture({user:alice});renderApp('/jobs');await screen.findByRole('heading',{name:'Collected opportunities'});
  expect(screen.queryByRole('button',{name:'AI Recommendation'})).not.toBeInTheDocument();
  expect(f.fetch.mock.calls.some(([path])=>path.includes('/ai/'))).toBe(false);
  await userEvent.click(screen.getByRole('link',{name:'Profiles',exact:true}));
  await userEvent.click(await screen.findByRole('button',{name:'Manage specializations for Daniel Zhang'}));
  expect(screen.queryByLabelText(/Specialization rule prompt/)).not.toBeInTheDocument();
});

it('recommendation uses applied filters without pagination, restores progress, refreshes jobs and stops',async()=>{
  const f=fixture();renderApp('/jobs?connectionId=profile-a&excludeBlacklistedCompanies=true&totalMatchMin=0&page=1&sortBy=title');
  const user=userEvent.setup();const button=await screen.findByRole('button',{name:'AI Recommendation'});
  await waitFor(()=>expect(button).toBeEnabled());await user.click(button);
  await screen.findByText('1 / 23 processed (4%)');
  const start=f.fetch.mock.calls.find(([path,options])=>path.endsWith('/ai/recommendations') && options.method==='POST');
  expect(JSON.parse(start[1].body)).toEqual({filters:{connectionId:'profile-a',excludeBlacklistedCompanies:true,totalMatchMin:0}});
  expect(button).toBeDisabled();expect(screen.getByRole('progressbar')).toHaveAttribute('value','4');
  await user.click(screen.getByRole('button',{name:'Stop recommendations'}));
  await screen.findByText('AI recommendations: stopped');await waitFor(()=>expect(button).toBeEnabled());
  expect(f.fetch.mock.calls.filter(([path,options])=>path.endsWith('/stop') && options.method==='POST')).toHaveLength(1);
});

it('reload restores running or completed operations and duplicate conflicts attach without submitting twice',async()=>{
  const f=fixture({conflict:true});renderApp('/jobs');const user=userEvent.setup();
  const button=await screen.findByRole('button',{name:'AI Recommendation'});await waitFor(()=>expect(button).toBeEnabled());await user.click(button);
  await screen.findByText('AI recommendations: running');
  expect(f.fetch.mock.calls.filter(([path,options])=>path.endsWith('/ai/recommendations') && options.method==='POST')).toHaveLength(1);
  expect(f.fetch.mock.calls.some(([path])=>path.endsWith('/ai/recommendations/recommendation-1'))).toBe(true);
});

it('restored terminal progress renders no-match and skipped reasons as text',async()=>{
  fixture({operation:task({status:'completed',processed:23,updated:12,unmatched:5,skipped:6,issues:[{code:'NO_PROMPT',count:6}]})});renderApp('/jobs');
  await screen.findByText('23 / 23 processed (100%)');
  expect(screen.getByText(/12 updated.*5 no match.*6 skipped/)).toBeInTheDocument();
  await userEvent.click(screen.getByText('Processing issues'));
  expect(screen.getByText('Profile has no rule prompt: 6')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Stop recommendations'})).not.toBeInTheDocument();
});

it('configuration and start failures stay inline and mutations do not retry',async()=>{
  const f=fixture({failure:true});renderApp('/jobs');const user=userEvent.setup();
  const button=await screen.findByRole('button',{name:'AI Recommendation'});await waitFor(()=>expect(button).toBeEnabled());await user.click(button);
  await screen.findByText('Recommendation could not start.');
  expect(f.fetch.mock.calls.filter(([path,options])=>path.endsWith('/ai/recommendations') && options.method==='POST')).toHaveLength(1);
  await user.click(screen.getByRole('link',{name:'Profiles',exact:true}));await user.click(await screen.findByRole('button',{name:'Manage specializations for Daniel Zhang'}));
  const dialog=screen.getByRole('dialog');await user.click(within(dialog).getByRole('button',{name:'Clear AI settings'}));
  expect(await within(dialog).findByText('Settings could not be saved.')).toBeInTheDocument();
});

it('missing server models explain configuration while keeping clear available',async()=>{
  fixture({configured:false});renderApp('/profiles');await userEvent.click(await screen.findByRole('button',{name:'Manage specializations for Daniel Zhang'}));
  await screen.findByText(/No JSON-capable AI models are enabled/);
  expect(screen.getByRole('button',{name:'Clear AI settings'})).toBeEnabled();
});
