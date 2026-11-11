import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { recommendationFixture } from './helpers/recommendation-fixture.js';
import { backendPassword } from './helpers/service-fixture.js';

test('browser UI: configure profile AI rules, categorize all filtered pages, restore progress, stop and review saved titles',async()=>{
  const f=await recommendationFixture({webDist:resolve('web/dist')});
  const browser=await chromium.launch({headless:true,channel:'chromium'});
  try{
    const address=await f.app.listen({host:'127.0.0.1',port:0});f.config.origin=address;f.config.allowedOrigins.splice(0,f.config.allowedOrigins.length,address);
    const ids=[];for(let i=0;i<21;i++)ids.push(f.save(f.one,'browser-'+i));
    f.save(f.blank,'blank');f.save(f.foreign,'private');
    await f.app.recommendations.start();
    const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    await page.goto(address+'/login');await page.getByLabel('Email address',{exact:true}).fill('admin@fixture.test');await page.getByLabel('Password',{exact:true}).fill(backendPassword);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('heading',{name:'Your collection, in motion.'}).waitFor();
    await page.getByRole('link',{name:'Profiles',exact:true}).click();await page.getByRole('button',{name:'Manage specializations for '+f.one.label}).click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('Specialization rule prompt').fill('Prefer Platform Engineer for developer tools.');
    await dialog.getByLabel('AI provider').selectOption('openai');await dialog.getByLabel('AI model').selectOption('openai-fixture');await dialog.getByRole('button',{name:'Save AI settings'}).click();await dialog.getByText('AI settings saved.').waitFor();
    await dialog.getByRole('button',{name:'Done',exact:true}).click();
    await page.goto(`${address}/jobs?connectionId=${f.one.id}&page=2`);await page.getByRole('button',{name:'AI Recommendation',exact:true}).waitFor();
    f.source.mode('openai','held');await page.getByRole('button',{name:'AI Recommendation',exact:true}).click();await f.source.waitFor(1);
    await page.getByText('AI recommendations: running',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Profiles',exact:true}).click();await page.getByRole('heading',{name:'Your connected profiles',exact:true}).waitFor();
    await page.goto(`${address}/jobs?connectionId=${f.one.id}&page=2`);await page.reload();await page.getByText('AI recommendations: running',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Stop recommendations',exact:true}).click();await page.getByText('AI recommendations: stopped',{exact:true}).waitFor();
    f.source.mode('openai','success');await page.getByRole('button',{name:'AI Recommendation',exact:true}).click();await page.getByText('AI recommendations: completed',{exact:true}).waitFor();
    await page.getByText('21 / 21 processed (100%)',{exact:true}).waitFor();
    assert.equal(f.source.requests.length,4);
    const jobs=await f.command('GET',`/jobs?connectionId=${f.one.id}&limit=100`);assert.equal(jobs.items.length,21);assert.ok(jobs.items.every(job=>job.preferredTitleId===f.first.id));
    await page.goto(`${address}/jobs/${ids[0]}`);await page.getByText('Preferred title',{exact:true}).waitFor();await page.getByText('Platform Engineer',{exact:true}).waitFor();
    await page.setViewportSize({width:375,height:850});await page.goto(address+'/jobs');await page.getByRole('button',{name:'AI Recommendation',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await f.close();}
});
