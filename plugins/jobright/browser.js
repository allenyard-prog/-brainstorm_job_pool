import { authenticate, origin } from './auth.js';
import { emptyDetails } from './normalize.js';
import { AuthenticationError, UnsupportedError, UncertainWriteError } from '../../src/core/errors.js';

const state = context => context.jobright ??= { writeEvidence: new Map() };
const cardSelector = '.job-card-flag-classname';
const detailSelector = '[class*="jobDetailContent"]';

export async function dismissTour(page) {
  const exit = page.locator('[id*="tour-exit-button-id"]');
  if (await exit.isVisible()) await exit.click();
}

export async function returnToList(context) {
  const { page } = context;
  await dismissTour(page);
  const close = page.locator('[id*="job-detail-close-button"],[class*="job-detail-close-button"]').first();
  if (await close.isVisible()) {
    await close.click();
    await page.waitForURL(/\/jobs\/recommend/);
  }
  if (!new URL(page.url()).pathname.startsWith('/jobs/recommend')) {
    await page.goto(`${origin(context)}/jobs/recommend`, { waitUntil: 'domcontentloaded' });
  }
}

export async function extractDetailDom(page) {
  await page.locator(`${detailSelector} h1`).waitFor();
  return page.locator(detailSelector).first().evaluate(root => {
    const text = selector => root.querySelector(selector)?.innerText?.trim() ?? null;
    const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5')];
    const heading = title => headings.find(e => e.textContent.trim() === title);
    const section = title => heading(title)?.closest('section');
    const texts = element => element ? [...element.querySelectorAll('[class*="listText"],li')].map(e => e.innerText.trim()).filter(Boolean) : [];
    const metadata = Object.fromEntries([...root.querySelectorAll('[class*="job-metadata-item"]')].map(e => [e.querySelector('svg[aria-label]')?.getAttribute('aria-label'), e.innerText.trim()]));
    const company = root.querySelector('[class*="job-company-detail-container"]');
    const clean = root.cloneNode(true);
    clean.querySelectorAll('script,style,[class*="insider-connection"],button').forEach(e => e.remove());
    const html = clean.innerHTML;
    clean.querySelectorAll('br').forEach(e => e.replaceWith('\n'));
    clean.querySelectorAll('p,div,li,section,h1,h2,h3,h4,h5').forEach(e => e.append('\n'));
    return {
      id: root.querySelector('[data-time-filter-job]')?.getAttribute('data-time-filter-job') ?? location.pathname.split('/').at(-1),
      title: text('h1'), companyName: text('[class*="company-name"]'),
      description: { text: clean.textContent.replace(/\n{3,}/g, '\n\n').trim(), html },
      metadata, locations: [text('[class*="primary-location"]') ?? metadata.position].filter(Boolean), responsibilities: texts(section('Responsibilities')),
      qualifications: { required: texts(heading('Required')?.parentElement), preferred: texts(heading('Preferred')?.parentElement) },
      benefits: texts(section('Benefits')),
      skills: [...root.querySelectorAll('[class*="qualification-tag"]')].map(e => e.innerText.trim()),
      company: company ? { text: company.innerText, html: company.innerHTML, links: [...company.querySelectorAll('a[href]')].map(e => ({ text: e.innerText, url: e.href })) } : {},
      applicationUrl: [...root.querySelectorAll('a')].find(e => /Original Job Post/i.test(e.innerText))?.href ?? null,
      postedAt: text('[class*="publish-time"]')?.replace(/^·\s*/, '') ?? null,
      sections: [...root.querySelectorAll('section')].filter(e => !e.className.includes('insider-connection')).map(e => ({ heading: e.querySelector('h2,h3')?.innerText ?? null, text: e.innerText })),
      matching: [...root.querySelectorAll('[role="progressbar"]')].map(e => ({ value: e.getAttribute('aria-valuenow'), text: e.parentElement.innerText })),
      sponsorshipTags: [...root.querySelectorAll('[class*="recommendation-tag"]')].map(e => e.innerText.trim()),
    };
  });
}

export function normalizeBrowserJob(snapshot, baseUrl, raw = null) {
  const details = emptyDetails();
  details.description = snapshot.description;
  details.locations = snapshot.locations;
  details.workArrangement = snapshot.metadata.remote ?? null;
  details.employmentType = snapshot.metadata.time ?? null;
  details.seniority = snapshot.metadata.seniority ?? null;
  details.compensation = { display: snapshot.metadata.money ?? null };
  details.responsibilities = snapshot.responsibilities;
  details.qualifications = snapshot.qualifications;
  details.skills = snapshot.skills;
  details.benefits = snapshot.benefits;
  details.experience = { display: snapshot.metadata.date ?? null };
  details.sponsorship = { tags: snapshot.sponsorshipTags };
  details.company = { name: snapshot.companyName, ...snapshot.company };
  details.applicationUrl = snapshot.applicationUrl;
  details.postedAt = snapshot.postedAt;
  details.matching = { charts: snapshot.matching };
  details.extra = { sections: snapshot.sections, metadata: snapshot.metadata };
  return { id: String(snapshot.id), url: `${baseUrl}/jobs/info/${snapshot.id}`, title: snapshot.title, company: snapshot.companyName, details, raw };
}

export default {
  authenticate,
  async listJobs(context, { excludeIds = [] } = {}) {
    context.signal?.throwIfAborted();
    context.recorder?.action('list');
    await returnToList(context);
    if (state(context).empty) await context.page.reload({ waitUntil: 'domcontentloaded' });
    if (await context.page.getByPlaceholder('Password', { exact: true }).isVisible()) throw new AuthenticationError('Jobright session expired.');
    // Do not reload while the initial recommendation request is still in flight.
    if (await context.page.locator(cardSelector).count() === 0) {
      await context.page.locator(cardSelector).first().waitFor({ timeout: 15000 }).catch(() => {});
      await context.recorder?.flush();
      const response = context.recorder?.entries.findLast(e => e.url.includes('/recommend/list/jobs') && e.response)?.response;
      if (response?.success === false) throw new AuthenticationError('Jobright recommendations are unavailable; check the session.');
      if (response?.result?.jobList?.length && await context.page.locator(cardSelector).count() === 0) throw new UnsupportedError('Recommendation data loaded but the job card layout changed.');
    }
    await dismissTour(context.page);
    const readCards = () => context.page.locator(cardSelector).evaluateAll(cards => cards.map(card => ({
      id: card.id,
      url: card.querySelector('a[href^="/jobs/info/"]')?.href,
      title: card.querySelector('h2')?.innerText,
    })).filter(job => job.id && job.url));
    let jobs = await readCards();
    const excluded = new Set(excludeIds);
    while (jobs.length && jobs.every(job => excluded.has(job.id))) {
      context.signal?.throwIfAborted();
      const count = jobs.length;
      await context.page.locator(cardSelector).last().scrollIntoViewIfNeeded();
      await context.page.mouse.wheel(0, 1200);
      await context.page.waitForTimeout(1500);
      jobs = await readCards();
      if (jobs.length <= count) break;
    }
    state(context).empty = jobs.length === 0;
    if (jobs.length) return jobs;
    return [];
  },
  async getJobDetails(context, job) {
    context.signal?.throwIfAborted();
    context.recorder?.action('detail', job.id);
    await returnToList(context);
    const card = context.page.locator(`[id="${job.id}"]`);
    if (await card.count()) await card.locator('a[href^="/jobs/info/"] h2').first().click();
    else await context.page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await dismissTour(context.page);
    await context.page.locator(`${detailSelector} h1`).waitFor();
    // Expand content only; never click skill tags, applications, or credit-consuming tools.
    for (const button of await context.page.locator(detailSelector).getByRole('button', { name: /^(show more|read more|view more)$/i }).all()) {
      if (await button.isVisible()) await button.click();
    }
    const snapshot = await extractDetailDom(context.page);
    const moreLocations = context.page.locator(detailSelector).locator('[class*="job-location-display"] [class*="more-tag"]').first();
    if (await moreLocations.isVisible()) {
      await moreLocations.hover();
      const tooltip = context.page.locator('.ant-tooltip-inner:visible,.ant-popover-inner:visible').last();
      try { await tooltip.waitFor({ timeout: 5000 }); }
      catch { throw new UnsupportedError('Additional job locations could not be expanded; the job will not be marked applied.'); }
      const expanded = (await tooltip.innerText()).split('\n').map(value => value.trim()).filter(Boolean);
      snapshot.locations = [...new Set([...snapshot.locations, ...expanded])];
      snapshot.locationTooltip = expanded;
      await context.page.mouse.move(0, 0);
    }
    await context.recorder?.flush();
    const lists = context.recorder?.entries.filter(e => e.url.includes('/recommend/list/jobs')) ?? [];
    const raw = lists.flatMap(e => e.response?.result?.jobList ?? []).findLast(e => String(e.jobResult?.jobId) === String(job.id)) ?? null;
    return normalizeBrowserJob(snapshot, origin(context), raw);
  },
  async markAsApplied(context, job) {
    context.signal?.throwIfAborted();
    await returnToList(context);
    context.signal?.throwIfAborted();
    const card = context.page.locator(`[id="${job.id}"]`);
    if (await card.count() !== 1) throw new UncertainWriteError('Selected job card is unavailable; no status action was clicked.');
    context.recorder?.action('mark', job.id);
    await card.locator('button.ant-dropdown-trigger').click();
    const responsePromise = context.page.waitForResponse(response => {
      const request = response.request();
      if (new URL(response.url()).pathname !== '/swan/job/apply' || request.method() !== 'POST') return false;
      try { return String(request.postDataJSON().jobId) === String(job.id) && request.postDataJSON().source === 0; }
      catch { return false; }
    }, { timeout: 15000 }).catch(() => null);
    context.signal?.throwIfAborted();
    await context.page.getByRole('menuitem', { name: /^already applied$/i }).click();
    const response = await responsePromise;
    if (response?.ok()) {
      const body = await response.json().catch(() => null);
      if (body?.success === true) state(context).writeEvidence.set(String(job.id), { url: response.url(), success: true });
    }
    await context.recorder?.flush();
  },
  async getApplicationStatus(context, job) {
    context.recorder?.action('verify', job.id);
    const evidence = state(context).writeEvidence.get(String(job.id));
    if (evidence) {
      try {
        await context.page.waitForFunction(id => !document.getElementById(id), String(job.id), { timeout: 10000 });
        state(context).writeEvidence.delete(String(job.id));
        return 'applied';
      } catch { /* Reconcile through the Applied page. */ }
    }
    await context.page.goto(`${origin(context)}/jobs/applied`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await context.page.waitForTimeout(1500);
    if (await context.page.locator(`[id="${job.id}"]`).count() || await context.page.locator(`a[href="/jobs/info/${job.id}"]`).count()) return 'applied';
    return 'unknown';
  },
};
