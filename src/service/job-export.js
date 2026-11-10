import { scrubSecrets } from './crypto.js';

const columns = ['id', 'title', 'company', 'url', 'site', 'connectionId', 'sourceJobId', 'processingState', 'websiteStatus', 'firstSeenAt', 'lastScrapedAt', 'assignedAt', 'details'];

function spreadsheetText(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Titles and other scraped strings must remain text when opened in a spreadsheet.
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return text;
}
const csvCell = value => `"${spreadsheetText(value).replaceAll('"', '""')}"`;

export async function* jobCsv(db, userId, filters, firstPage) {
  yield '\uFEFF' + columns.join(',') + '\r\n';
  let page = firstPage;
  while (true) {
    for (const job of page.items) {
      const safe = scrubSecrets(job);
      yield columns.map(column => csvCell(safe[column])).join(',') + '\r\n';
    }
    if (!page.nextCursor) break;
    page = await db.call('listJobs', userId, { ...filters, cursor: page.nextCursor, limit: 100, includeDetails: true });
  }
}

export async function* jobTsv(db, userId, filters, firstPage) {
  yield 'Company Name\tJob Title\tLink\n';
  let page = firstPage;
  while (true) {
    for (const job of page.items) {
      yield [job.company, job.title, applicationLink(job.applicationUrl)]
        .map(value => spreadsheetText(value).replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n';
    }
    if (!page.nextCursor) break;
    page = await db.call('listJobs', userId, { ...filters, cursor: page.nextCursor, limit: 100, includeApplicationUrl: true });
  }
}

function applicationLink(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || hostname === 'jobright.ai' || hostname.endsWith('.jobright.ai')) return '';
    return url.href;
  } catch { return ''; }
}
