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
      yield [job.company, job.title, job.url]
        .map(value => spreadsheetText(value).replace(/[\t\r\n]+/g, ' ')).join('\t') + '\n';
    }
    if (!page.nextCursor) break;
    page = await db.call('listJobs', userId, { ...filters, cursor: page.nextCursor, limit: 100 });
  }
}
