import { chromium } from 'playwright';
import { mkdir, access, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function openBrowser({ sessionPath, headed = false, timeout = 30000, recorder, channel }) {
  let storageState;
  try { await access(sessionPath); storageState = sessionPath; } catch { /* First login. */ }
  const browser = await chromium.launch({ headless: !headed, channel: channel ?? 'chromium' });
  try {
    const context = await browser.newContext({ storageState });
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    recorder?.attach(context);
    const page = await context.newPage();
    return {
      browser, context, page, hasSession: Boolean(storageState),
      async saveSession() {
        await mkdir(dirname(sessionPath), { recursive: true });
        const temporary = `${sessionPath}.tmp`;
        await context.storageState({ path: temporary, indexedDB: true });
        await rename(temporary, sessionPath);
      },
      async close() { try { await recorder?.close(); } finally { await browser.close(); } },
    };
  } catch (error) { await browser.close(); throw error; }
}
