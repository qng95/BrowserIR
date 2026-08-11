import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';

/**
 * Interaction patterns that exist only while the user is interacting.
 *
 * Bulk bars, context menus and toasts are all transient: none of them are in
 * the document an agent receives, and two of them disappear again shortly
 * after. They cannot be asserted from server-rendered HTML at all, which is
 * exactly why they belong in a browser suite.
 */
let app: RunningAppServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startAppServer({ apiLatencyMs: 100, pageLatencyMs: 0, customers: 120, vehicles: 400 });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`${app.origin}/app/login`);
  await page.fill('#username', 'test');
  await page.fill('#password', 'test');
  await page.click('button[type=submit]');
  await page.waitForURL('**/app/customers');
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

describe('bulk selection', () => {
  it('has no action bar until something is selected', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');
    // The operations an agent is asked to perform are not in the idle document.
    expect(await page.locator('.bulkbar').count()).toBe(0);

    await page.locator('.rowsel').first().check();
    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('#bulkcount')).toBe('1 selected');

    await page.locator('.rowsel').nth(1).check();
    expect(await page.textContent('#bulkcount')).toBe('2 selected');

    await page.click('[data-bulk=clear]');
    expect(await page.locator('.bulkbar').count()).toBe(0);
  }, 30_000);

  it('select-all ticks every row on the page', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');
    const rows = await page.locator('.rowsel').count();
    await page.check('#selall');
    await page.waitForSelector('.bulkbar');
    expect(await page.textContent('#bulkcount')).toBe(`${rows} selected`);
  }, 30_000);

  it('applies a bulk action to exactly the selected orders', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');

    const ids = await page.locator('tr[data-order]').evaluateAll((rows) =>
      rows.slice(0, 3).map((r) => Number(r.getAttribute('data-order'))),
    );
    for (let i = 0; i < 3; i++) await page.locator('.rowsel').nth(i).check();

    await page.waitForSelector('.bulkbar');
    await page.click('[data-bulk=confirm]');
    await page.waitForURL('**/app/orders**');

    const rows = app.db
      .prepare(`SELECT id, status FROM orders WHERE id IN (${ids.join(',')})`)
      .all() as Array<{ id: number; status: string }>;
    expect(rows.map((r) => r.status)).toEqual(['Confirmed', 'Confirmed', 'Confirmed']);

    const audited = app.db
      .prepare(`SELECT COUNT(*) AS n FROM audit WHERE action = 'order.confirm' AND entity_id IN (${ids.join(',')})`)
      .get() as { n: number };
    expect(audited.n).toBe(3);
  }, 45_000);
});

describe('context menu', () => {
  it('exists only between right-click and the next click', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');
    expect(await page.locator('.ctxmenu').count()).toBe(0);

    await page.locator('tr[data-order]').first().click({ button: 'right' });
    await page.waitForSelector('.ctxmenu');
    expect(await page.locator('.ctxmenu [role=menuitem]').count()).toBe(3);

    // Clicking away destroys it — a snapshot taken a moment later shows nothing.
    await page.mouse.click(5, 5);
    expect(await page.locator('.ctxmenu').count()).toBe(0);
  }, 30_000);

  it('performs the action on the row that was right-clicked', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');

    const target = page.locator('tr[data-order]').nth(4);
    const id = Number(await target.getAttribute('data-order'));

    await target.click({ button: 'right' });
    await page.waitForSelector('.ctxmenu');
    await page.click('[data-ctx=cancel]');
    await page.waitForURL('**/app/orders**');

    const row = app.db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('Cancelled');
  }, 45_000);
});

describe('toasts are transient', () => {
  it('appears after an action and removes itself', async () => {
    await page.goto(`${app.origin}/app/orders`);
    await page.waitForSelector('tr[data-order]');
    await page.locator('.rowsel').first().check();
    await page.waitForSelector('.bulkbar');
    await page.click('[data-bulk=deliver]');

    await page.waitForSelector('.toast');
    expect(await page.textContent('.toast')).toContain('set to Delivered');

    // Gone within a few seconds; the outcome must be recovered from state.
    await page.waitForSelector('.toastwrap', { state: 'detached', timeout: 12_000 });
    expect(await page.locator('.toast').count()).toBe(0);
  }, 45_000);
});

describe('long-running export', () => {
  it('polls to completion and only then offers the download', async () => {
    await page.goto(`${app.origin}/app/reports/export?jobMs=2500`);
    await page.click('#startexport');
    await page.waitForURL('**/app/reports/export?job=**');

    await page.waitForSelector('#jobcard[data-state=running]');
    // The download does not exist while the job is running.
    expect(await page.locator('#download').count()).toBe(0);
    expect(await page.textContent('#jobstatus')).toMatch(/Starting|Exporting/);

    await page.waitForSelector('#jobcard[data-state=done]', { timeout: 20_000 });
    expect(await page.textContent('#jobstatus')).toContain('Export complete');
    await page.waitForSelector('#download');

    const href = await page.getAttribute('#download', 'href');
    const csv = await (await fetch(app.origin + href!, {
      headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') },
    })).text();
    expect(csv.split('\n')[0]).toBe('number,name,status,city,country');
  }, 60_000);

  it('refuses to download a job that has not finished', async () => {
    await page.goto(`${app.origin}/app/reports/export?jobMs=20000`);
    await page.click('#startexport');
    await page.waitForURL('**/app/reports/export?job=**');
    const jobId = new URL(page.url()).searchParams.get('job')!;

    await page.goto(`${app.origin}/app/reports/export/${jobId}/download`);
    await page.waitForSelector('.toast');
    expect(await page.textContent('.toast')).toContain('not finished yet');
  }, 60_000);
});
