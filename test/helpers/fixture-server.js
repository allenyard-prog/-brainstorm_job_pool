import { createServer } from 'node:http';
import { once } from 'node:events';

export const fixtureJob = id => ({
  jobResult: {
    jobId: id, jobTitle: `Engineer ${id}`, jobLocation: 'New York, NY', jobLocations: id === 'multi' ? ['New York, NY', 'San Francisco, CA'] : ['New York, NY'],
    workModel: 'Remote', employmentType: 'Full-time', jobSeniority: 'Senior Level',
    salaryDesc: '$150K/yr - $180K/yr', minSalary: 150000, maxSalary: 180000,
    jobSummary: `Build reliable data systems ${id}.`, coreResponsibilities: ['Build pipelines', 'Maintain data quality'],
    qualifications: { mustHave: ['SQL', 'Five years experience'], preferredHave: ['Python'] },
    benefitsSummaries: ['Health insurance'], jdCoreSkills: [{ skill: 'SQL', score: 3 }],
    educationSummaries: [], minYearsOfExperience: 5, publishTime: '2026-11-01 12:00:00',
    applyLink: `https://employer.test/apply/${id}`, unknownFutureField: { nested: 'preserved' },
  },
  companyResult: { companyName: 'Fixture Corp', companyDesc: 'A fixture company.' },
  isLiked: false,
});

const document = body => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
export async function startFixtureServer({ ids = ['a', 'b', 'c'] } = {}) {
  const applied = new Set();
  const requests = [];
  let authenticated = true;
  let loseWriteResponse = false;
  let brokenSchema = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null });
    const json = result => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, errorCode: 10000, result })); };
    if (url.pathname.startsWith('/swan/') && (!authenticated || !req.headers.cookie?.includes('fixture-session=valid'))) {
      res.statusCode = 401; res.end('Unauthenticated'); return;
    }
    if (url.pathname === '/fixture-login') {
      const credentials = JSON.parse(body);
      if (credentials.email !== 'fixture@example.test' || credentials.password !== 'fixture-password') { res.statusCode = 401; res.end('{}'); return; }
      res.setHeader('Set-Cookie', 'fixture-session=valid; Path=/; HttpOnly; SameSite=Lax');
      json(true); return;
    }
    if (url.pathname === '/swan/recommend/list/jobs') {
      const position = Number(url.searchParams.get('position') ?? 0);
      const count = Number(url.searchParams.get('count') ?? 20);
      json(brokenSchema ? { changed: [] } : { jobList: ids.filter(id => !applied.has(id)).slice(position, position + count).map(fixtureJob), impId: 'fixture-impression' }); return;
    }
    if (url.pathname === '/swan/job/apply' && req.method === 'POST') {
      const payload = JSON.parse(body);
      if (!ids.includes(payload.jobId) || payload.source !== 0) { res.statusCode = 400; res.end('{}'); return; }
      applied.add(payload.jobId);
      if (loseWriteResponse) { loseWriteResponse = false; res.destroy(); return; }
      json(true); return;
    }
    if (url.pathname === '/swan/job/applied/jobs-v3') {
      const payload = JSON.parse(body);
      const offset = Number(payload.cursor?.split('-').at(-1) ?? 0);
      const all = [...applied].reverse();
      const list = all.slice(offset, offset + payload.pageSize).map(id => ({ ...fixtureJob(id), applyStatus: 0, source: 0 }));
      const hasMore = offset + list.length < all.length;
      json({ list, hasMore, cursor: hasMore ? `fixture-${offset + list.length}` : null }); return;
    }
    if (url.pathname === '/') {
      if (req.headers.cookie?.includes('fixture-session=valid')) { res.writeHead(302, { Location: '/jobs/recommend' }); res.end(); return; }
      res.end(document(`<button onclick="document.querySelector('.ant-modal').hidden=false">SIGN IN</button>
        <div role="dialog" class="ant-modal" hidden><input placeholder="Email"><input type="password" placeholder="Password"><button id="submit">SIGN IN</button></div>
        <script>document.querySelector('#submit').onclick=async()=>{const r=await fetch('/fixture-login',{method:'POST',body:JSON.stringify({email:document.querySelector('[placeholder=Email]').value,password:document.querySelector('[placeholder=Password]').value})});if(r.ok)location.href='/jobs/recommend';else document.body.insertAdjacentHTML('beforeend','<div class="ant-message-error">Sign in failed</div>');};</script>`)); return;
    }
    if (url.pathname === '/jobs/recommend' || url.pathname === '/jobs/applied') {
      if (!req.headers.cookie?.includes('fixture-session=valid')) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      const visible = url.pathname.endsWith('applied') ? [...applied] : ids.filter(id => !applied.has(id));
      res.end(document(`<a href="/jobs/profile">Account</a><main>${visible.map(id => `<div class="job-card-flag-classname" id="${id}"><a href="/jobs/info/${id}"><h2>Engineer ${id}</h2></a><button class="ant-dropdown-trigger" onclick="document.querySelector('#menu-${id}').hidden=false">Options</button><div id="menu-${id}" role="menu" hidden><button role="menuitem" onclick="mark('${id}')">Already Applied</button></div></div>`).join('')}</main><script>fetch('/swan/recommend/list/jobs?refresh=true&sortCondition=0&position=0&count=20&syncRerank=false');async function mark(id){const r=await fetch('/swan/job/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:id,source:0})});if(r.ok)document.getElementById(id).remove();}</script>`)); return;
    }
    if (url.pathname.startsWith('/jobs/info/')) {
      const id = url.pathname.split('/').at(-1);
      res.end(document(`<a href="/jobs/profile">Account</a><div class="index_jobDetailContent_fixture">
        <button id="index_job-detail-close-button__ZGvhR" onclick="location.href='/jobs/recommend'">Close</button>
        <div class="index_company-name_fixture">Fixture Corp</div><h1>Engineer ${id}</h1>
        <div class="index_job-metadata-item_fixture" data-time-filter-job="${id}"><svg aria-label="position"></svg><span class="index_job-location-display_fixture"><span class="index_primary-location_fixture">New York, NY</span>${id === 'multi' ? '<span class="index_more-tag_fixture" onmouseover="document.querySelector(\'.ant-tooltip-inner\').hidden=false">+1 more</span>' : ''}</span></div>
        <div class="index_job-metadata-item_fixture"><svg aria-label="remote"></svg>Remote</div>
        <div class="index_job-metadata-item_fixture"><svg aria-label="time"></svg>Full-time</div>
        <div class="index_job-metadata-item_fixture"><svg aria-label="seniority"></svg>Senior Level</div>
        <p>Build reliable data systems ${id}.</p>
        <section><h2>Responsibilities</h2><span class="index_listText_fixture">Build pipelines</span><span class="index_listText_fixture">Maintain data quality</span></section>
        <section><h2>Qualification</h2><span class="index_qualification-tag_fixture">SQL</span><div><h4>Required</h4><span class="index_listText_fixture">SQL</span><span class="index_listText_fixture">Five years experience</span></div><div><h4>Preferred</h4><span class="index_listText_fixture">Python</span></div></section>
        <section><h2>Benefits</h2><span class="index_listText_fixture">Health insurance</span></section>
        <div class="index_job-company-detail-container_fixture">A fixture company.</div>
        <a href="https://employer.test/apply/${id}">Original Job Post</a>
      </div>${id === 'multi' ? '<div class="ant-tooltip-inner" hidden>New York, NY<br>San Francisco, CA</div>' : ''}`)); return;
    }
    res.statusCode = 404; res.end('Not found');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, applied, expire: () => { authenticated = false; }, loseNextWriteResponse: () => { loseWriteResponse = true; }, breakSchema: value => { brokenSchema = value; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
