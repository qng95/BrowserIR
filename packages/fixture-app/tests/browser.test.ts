import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';
import { taskById } from '../src/tasks.js';

/**
 * Browser tests.
 *
 * Everything here is a behaviour that only exists at runtime and that no
 * amount of asserting on server-rendered HTML can reach: debounce windows,
 * skeleton→data transitions, row recycling during a scroll, modals rendered
 * outside the form they feed.
 *
 * This suite exists because every significant bug in this repository so far —
 * escaped script content, a mis-targeted hydration wrapper, `[hidden]` losing
 * to a class rule, shadow-boundary event retargeting, a virtual scroller that
 * silently stopped in a background tab — was found by loading a page by hand
 * while the non-browser suites stayed green.
 */
let app: RunningAppServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startAppServer({ apiLatencyMs: 250, pageLatencyMs: 0, customers: 300, vehicles: 3000 });
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

async function signIn(): Promise<void> {
  await page.goto(`${app.origin}/app/customers`);
  if (page.url().includes('/app/login')) {
    await page.fill('#username', 'test');
    await page.fill('#password', 'test');
    await page.click('button[type=submit]');
    await page.waitForURL('**/app/customers');
  }
}

describe('sign-in gate', () => {
  it('redirects an unauthenticated visit and accepts test/test', async () => {
    await page.goto(`${app.origin}/app/vehicles`);
    expect(page.url()).toContain('/app/login');
    // The next URL is preserved, so signing in returns where the agent meant to go.
    expect(page.url()).toContain('next=');

    await page.fill('#username', 'test');
    await page.fill('#password', 'test');
    await page.click('button[type=submit]');
    await page.waitForURL('**/app/vehicles');
    expect(await page.textContent('.who')).toContain('S. Weber');
  }, 30_000);
});

describe('lazy panels', () => {
  it('shows a skeleton first, then the data', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/customers/1/contacts`);

    // Before the round trip completes the panel is busy and holds no rows.
    expect(await page.getAttribute('#panel', 'data-state')).toBe('loading');
    expect(await page.locator('#panel .skeleton').count()).toBe(1);
    expect(await page.locator('#panel tbody tr').count()).toBe(0);

    await page.waitForSelector('#panel[data-state=ready]', { timeout: 10_000 });
    expect(await page.locator('#panel tbody tr').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-loading]').count()).toBe(0);
  }, 30_000);
});

describe('virtualised inventory', () => {
  it('keeps only a window in the DOM and recycles rows on scroll', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/vehicles`);
    await page.waitForSelector('.vrow[data-vehicle]');

    const inDom = await page.locator('.vrow[data-vehicle]').count();
    expect(inDom).toBeLessThanOrEqual(40);
    expect(await page.getAttribute('.vgrid', 'data-total')).toBe('3000');

    const firstBefore = await page.getAttribute('.vrow[data-vehicle]', 'data-vehicle');

    await page.evaluate(() => {
      const vp = document.getElementById('vviewport')!;
      vp.scrollTop = 34 * 1800;
    });
    await page.waitForFunction(
      (before) => document.querySelector('.vrow[data-vehicle]')?.getAttribute('data-vehicle') !== before,
      firstBefore,
      { timeout: 10_000 },
    );

    const firstAfter = await page.getAttribute('.vrow[data-vehicle]', 'data-vehicle');
    // Same node count, different records: this is the identity churn that
    // breaks refs anchored to DOM nodes.
    expect(await page.locator('.vrow[data-vehicle]').count()).toBeLessThanOrEqual(40);
    expect(firstAfter).not.toBe(firstBefore);
    expect(await page.textContent('#vwindow')).toContain('showing 1801');
  }, 45_000);

  it('scrolling back shows the original rows again', async () => {
    await page.evaluate(() => {
      document.getElementById('vviewport')!.scrollTop = 0;
    });
    await page.waitForFunction(
      () => document.querySelector('.vrow[data-vehicle]')?.getAttribute('data-index') === '0',
      undefined,
      { timeout: 10_000 },
    );
    expect(await page.getAttribute('.vrow[data-vehicle]', 'data-vehicle')).toBe('1');
  }, 30_000);
});

describe('order wizard', () => {
  it('autocomplete returns nothing until the debounce elapses', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/orders/new`);

    expect(await page.locator('#cust-list [role=option]').count()).toBe(0);

    await page.fill('#cust-input', 'Adler');
    // Immediately after typing there is still nothing — a reader that does not
    // wait concludes the control has no options.
    expect(await page.locator('#cust-list [role=option]').count()).toBe(0);

    await page.waitForSelector('#cust-list [role=option]', { timeout: 10_000 });
    expect(await page.locator('#cust-list [role=option]').count()).toBeGreaterThan(0);

    await page.locator('#cust-list [role=option]').first().click();
    expect(await page.inputValue('#cust-id')).not.toBe('');
    expect(await page.locator('#cust-list').isHidden()).toBe(true);
  }, 45_000);

  it('drives the modal picker and completes the order end to end', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/orders/new`);

    // Step 1 — customer, via the debounced autocomplete.
    await page.fill('#cust-input', 'K-100032');
    await page.waitForSelector('#cust-list [role=option]', { timeout: 10_000 });
    await page.locator('#cust-list [role=option]').first().click();
    await page.click('button.primary');

    // Step 2 — vehicle, via a modal rendered outside the form.
    await page.waitForSelector('#veh-open');
    expect(await page.locator('#veh-modal').isHidden()).toBe(true);
    await page.click('#veh-open');
    expect(await page.locator('#veh-results .skeleton').count()).toBe(1);

    await page.waitForSelector('#veh-results [role=option]', { timeout: 10_000 });
    const inStock = page.locator('#veh-results [role=option]:not([data-sold])').first();
    await inStock.click();
    expect(await page.locator('#veh-modal').isHidden()).toBe(true);
    expect(await page.inputValue('#veh-id')).not.toBe('');
    await page.click('button.primary');

    // Step 3 — a date rule only discoverable by submitting.
    await page.waitForSelector('#delivery_on');
    await page.fill('#delivery_on', '2026-07-01');
    await page.click('button.primary');
    await page.waitForSelector('#err-delivery_on');
    expect(await page.textContent('#err-delivery_on')).toContain('2026-08-01');

    await page.fill('#delivery_on', '2026-09-30');
    await page.click('button.primary');

    // Step 4 — review, then submit.
    await page.waitForSelector('li.current');
    expect(await page.textContent('li.current')).toContain('Review');
    await page.click('button.primary');
    await page.waitForURL('**/app/orders');
    expect(await page.textContent('.flash.ok')).toContain('created and vehicle reserved');

    const verdict = taskById('order-through-wizard')!.verify(app.db);
    expect(verdict.passed, verdict.reason).toBe(true);
  }, 90_000);
});

describe('inventory task, end to end through the UI', () => {
  it('finds a VIN deep in a 3,000-row list and changes its status', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/vehicles?q=WV1ZZZ0002500`);
    await page.waitForSelector('.vrow[data-vehicle]');

    const vin = await page.textContent('.vrow[data-vehicle] .vin');
    expect(vin).toContain('WV1ZZZ0002500');

    await page.click('.vrow[data-vehicle] .act a');
    await page.waitForSelector('#vstatus');
    await page.selectOption('#vstatus', 'Demo');
    await page.click('button.primary');

    await page.waitForSelector('.flash.ok');
    expect(await page.textContent('.flash.ok')).toContain('is now Demo');

    const row = app.db.prepare("SELECT status FROM vehicles WHERE vin = 'WV1ZZZ0002500'").get() as {
      status: string;
    };
    expect(row.status).toBe('Demo');
  }, 45_000);
});
