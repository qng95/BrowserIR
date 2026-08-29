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

  it('replaces a failed lazy panel with a settled error state', async () => {
    await signIn();
    await page.route('**/api/customers/1/contacts*', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
    });
    try {
      await page.goto(`${app.origin}/app/customers/1/contacts`);
      await page.waitForSelector('#panel[data-state=error]');
      expect(await page.textContent('#panel')).toContain('could not be loaded');
      expect(await page.getAttribute('#panel', 'aria-busy')).toBeNull();
      expect(await page.locator('[data-loading]').count()).toBe(0);
    } finally {
      await page.unroute('**/api/customers/1/contacts*');
    }
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

    await page.locator('#cust-input').press('ArrowDown');
    expect(await page.getAttribute('#cust-input', 'aria-activedescendant')).toBeTruthy();
    await page.locator('#cust-input').press('Enter');
    expect(await page.inputValue('#cust-id')).not.toBe('');
    expect(await page.locator('#cust-list').isHidden()).toBe(true);
  }, 45_000);

  it('cancels a queued autocomplete search when the combobox closes', async () => {
    await signIn();
    let searchRequests = 0;
    await page.route('**/api/customers/search?*', async (route) => {
      searchRequests += 1;
      await route.continue();
    });
    try {
      await page.goto(`${app.origin}/app/orders/new`);
      await page.fill('#cust-input', 'Adler');
      await page.click('h2');
      await page.waitForTimeout(600);
      expect(searchRequests).toBe(0);
      expect(await page.locator('#cust-list').isHidden()).toBe(true);
      expect(await page.getAttribute('#cust-input', 'aria-expanded')).toBe('false');

      await page.fill('#cust-input', 'Adler');
      await page.locator('#cust-input').press('Escape');
      await page.waitForTimeout(600);
      expect(searchRequests).toBe(0);
      expect(await page.locator('#cust-list').isHidden()).toBe(true);
    } finally {
      await page.unroute('**/api/customers/search?*');
    }
  }, 45_000);

  it('shows a recoverable error when autocomplete search fails', async () => {
    await signIn();
    await page.route('**/api/customers/search?*', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
    });
    try {
      await page.goto(`${app.origin}/app/orders/new`);
      await page.fill('#cust-input', 'Adler');
      await page.waitForSelector('#cust-list [role=alert]', { timeout: 10_000 });
      expect(await page.textContent('#cust-list')).toContain('Could not load customers');
      expect(await page.getAttribute('#cust-input', 'aria-expanded')).toBe('true');
    } finally {
      await page.unroute('**/api/customers/search?*');
    }
  }, 45_000);

  it('does not let an older autocomplete response overwrite a newer query', async () => {
    await signIn();
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    await page.route('**/api/customers/search?*', async (route) => {
      const term = new URL(route.request().url()).searchParams.get('q');
      if (term === 'Old') await oldBlocked;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ id: term === 'Old' ? 1 : 2, number: term === 'Old' ? 'K-OLD' : 'K-NEW', name: `${term} Customer`, city: 'Berlin' }],
          }),
        });
      } catch {
        // The old request is expected to be aborted by the second query.
      }
    });
    try {
      await page.goto(`${app.origin}/app/orders/new`);
      const oldRequest = page.waitForRequest((request) => request.url().includes('q=Old'));
      await page.fill('#cust-input', 'Old');
      await oldRequest;
      await page.fill('#cust-input', 'New');
      await page.waitForSelector('#cust-list [role=option]:has-text("New Customer")');
      releaseOld();
      await page.waitForTimeout(150);
      expect(await page.textContent('#cust-list')).toContain('New Customer');
      expect(await page.textContent('#cust-list')).not.toContain('Old Customer');
    } finally {
      releaseOld();
      await page.unroute('**/api/customers/search?*');
    }
  }, 45_000);

  it('shows an error in the vehicle modal and still closes it safely', async () => {
    await signIn();
    await page.goto(`${app.origin}/app/orders/new`);
    await page.evaluate(() => { (document.getElementById('cust-id') as HTMLInputElement).value = '1'; });
    await page.click('button.primary');
    await page.waitForSelector('#veh-open');
    await page.route('**/api/vehicles/pick?*', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
    });
    try {
      await page.click('#veh-open');
      await page.waitForSelector('#veh-results[data-state="error"]', { timeout: 10_000 });
      expect(await page.textContent('#veh-results')).toContain('Could not load vehicles');
      await page.keyboard.press('Escape');
      expect(await page.locator('#veh-modal').isHidden()).toBe(true);
      expect(await page.locator('#veh-open').evaluate((button) => button === document.activeElement)).toBe(true);
    } finally {
      await page.unroute('**/api/vehicles/pick?*');
    }
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

    await page.keyboard.press('Escape');
    expect(await page.locator('#veh-modal').isHidden()).toBe(true);
    expect(await page.locator('#veh-open').evaluate((button) => button === document.activeElement)).toBe(true);

    await page.click('#veh-open');
    expect(await page.locator('#veh-q').evaluate((input) => input === document.activeElement)).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.locator('button[data-close-modal]').evaluate((button) => button === document.activeElement)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator('#veh-q').evaluate((input) => input === document.activeElement)).toBe(true);

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
    await page.fill('#deposit', '5000');
    await page.fill('#notes', 'Fleet livery');
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
