import { AuthenticationError } from '../../src/core/errors.js';

export const origin = context => context.config.baseUrl ?? 'https://jobright.ai';
export async function authenticate(context) {
  const { page, credentials, recorder, signal } = context;
  signal?.throwIfAborted();
  recorder?.action('authentication');
  await page.goto(context.hasSession ? `${origin(context)}/jobs/recommend` : origin(context), { waitUntil: 'domcontentloaded' });
  const signIn = page.getByRole('button', { name: /^sign in$/i }).first();
  await page.waitForTimeout(1000);
  if (await signIn.isVisible()) {
    try { await signIn.click({ timeout: 5000 }); }
    catch (error) { if (!new URL(page.url()).pathname.startsWith('/jobs/')) throw error; }
    const modal = page.locator('.ant-modal:visible').last();
    if (await modal.getByPlaceholder('Email', { exact: true }).isVisible()) {
      await modal.getByPlaceholder('Email', { exact: true }).fill(credentials.email);
      await modal.getByPlaceholder('Password', { exact: true }).fill(credentials.password);
      await modal.getByRole('button', { name: /^sign in$/i }).click();
      try {
        await Promise.race([
          page.waitForURL(/\/jobs\//, { timeout: 30000 }),
          page.locator('.ant-message-error,.ant-form-item-explain-error').first().waitFor({ timeout: 30000 }).then(() => { throw new AuthenticationError('Jobright rejected the sign-in information.'); }),
        ]);
      }
      catch {
        throw new AuthenticationError('Login did not reach the jobs area. Check credentials or complete interactive verification using the headed login command.');
      }
    }
  }
  if (!page.url().includes('/jobs/recommend')) await page.goto(`${origin(context)}/jobs/recommend`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (await page.getByPlaceholder('Password', { exact: true }).isVisible() || await page.getByRole('button', { name: /^sign in$/i }).first().isVisible()) {
    throw new AuthenticationError('The authenticated session is unavailable or expired. Run the login command.');
  }
  try { await page.locator('a[href="/jobs/profile"]').first().waitFor({ timeout: 15000 }); }
  catch { throw new AuthenticationError('Authenticated account navigation was not found. Run the headed login command.'); }
  await context.saveSession();
  context.log?.('authenticated');
}
