import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';
import { taskById } from '../src/tasks.js';

/**
 * Dashboard, invoices, tickets and the query builder.
 *
 * Between them these cover the last patterns an inventory ERP needs and no snapshot can
 * reach: tiles that settle independently, a print document in a second tab,
 * an editor that does not exist until a double click, and form rows that the
 * user has to create before they can be filled in.
 */
let app: RunningAppServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startAppServer({ apiLatencyMs: 120, pageLatencyMs: 0, customers: 150, vehicles: 300 });
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

describe('dashboard', () => {
  it('settles tile by tile rather than all at once', async () => {
    await page.goto(`${app.origin}/app/dashboard`);
    // Every tile starts busy with a placeholder rather than a value.
    expect(await page.locator('[data-tile][data-state=loading]').count()).toBe(4);
    expect(await page.locator('[data-tile] .skeleton').count()).toBe(4);

    await page.waitForSelector('[data-tile][data-state=ready]');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-tile][data-state=ready]').length === 4,
      undefined,
      { timeout: 15_000 },
    );
    const values = await page.locator('.tvalue').allTextContents();
    expect(values.every((v) => v.trim().length > 0)).toBe(true);

    await page.waitForSelector('#activity[data-state=ready]');
  }, 45_000);

  it('settles a failed tile into an announced error state', async () => {
    await page.route('**/api/dashboard/tickets', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
    });
    try {
      await page.goto(`${app.origin}/app/dashboard`);
      const tile = page.locator('[data-tile=tickets]');
      await page.waitForSelector('[data-tile=tickets][data-state=error]');
      expect(await tile.textContent()).toContain('Unavailable');
      expect(await tile.getAttribute('aria-busy')).toBeNull();
    } finally {
      await page.unroute('**/api/dashboard/tickets');
    }
  }, 45_000);
});

describe('invoices', () => {
  it('opens the print document in a second tab', async () => {
    const inv = app.db.prepare('SELECT id, number FROM invoices ORDER BY id LIMIT 1').get() as {
      id: number;
      number: string;
    };
    await page.goto(`${app.origin}/app/invoices/${inv.id}`);

    // target=_blank: the agent has to notice a new tab appeared and switch.
    const [printTab] = await Promise.all([
      page.context().waitForEvent('page'),
      page.click('#printlink'),
    ]);
    await printTab!.waitForLoadState();
    expect(printTab!.url()).toContain(`/app/invoices/${inv.id}/print`);
    expect(await printTab!.textContent('h1')).toContain(inv.number);
    // The print document has none of the application chrome.
    expect(await printTab!.locator('.sidenav').count()).toBe(0);
    expect(await printTab!.locator('#doprint').count()).toBe(1);
    await printTab!.close();
  }, 45_000);

  it('rejects a payment larger than the outstanding amount', async () => {
    const inv = app.db
      .prepare("SELECT * FROM invoices WHERE status != 'Paid' ORDER BY id LIMIT 1")
      .get() as { id: number; total_cents: number; paid_cents: number };
    const outstanding = inv.total_cents - inv.paid_cents;

    await page.goto(`${app.origin}/app/invoices/${inv.id}`);
    await page.fill('#amount', String(Math.round(outstanding / 100) + 500));
    await page.click('button.primary');
    await page.waitForSelector('.toast');
    expect(await page.textContent('.toast')).toContain('exceeds the outstanding');

    const after = app.db.prepare('SELECT paid_cents FROM invoices WHERE id = ?').get(inv.id) as {
      paid_cents: number;
    };
    expect(after.paid_cents).toBe(inv.paid_cents);
  }, 45_000);

  it('settles an invoice and flips it to Paid', async () => {
    const inv = app.db
      .prepare("SELECT * FROM invoices WHERE status != 'Paid' ORDER BY id LIMIT 1")
      .get() as { id: number; total_cents: number; paid_cents: number };
    const outstanding = inv.total_cents - inv.paid_cents;

    await page.goto(`${app.origin}/app/invoices/${inv.id}`);
    await page.fill('#amount', String(Math.round(outstanding / 100)));
    await page.click('button.primary');
    await page.waitForSelector('.toast');

    const after = app.db.prepare('SELECT status, paid_cents FROM invoices WHERE id = ?').get(inv.id) as {
      status: string;
      paid_cents: number;
    };
    expect(after.status).toBe('Paid');
    expect(after.paid_cents).toBe(inv.total_cents);
  }, 45_000);
});

describe('tickets inline editing', () => {
  it('single click selects, only double click opens an editor', async () => {
    await page.goto(`${app.origin}/app/tickets`);
    await page.waitForSelector('tr[data-ticket]');

    const cell = page.locator('td.editable[data-field=priority]').first();
    await cell.click();
    // The same cell behaves differently on click and double click — the case a
    // single "interactive" boolean cannot represent.
    expect(await page.locator('tr[aria-selected=true]').count()).toBe(1);
    expect(await page.locator('td.editable select').count()).toBe(0);

    await cell.dblclick();
    await page.waitForSelector('td.editable select');
    expect(await page.locator('td.editable select').count()).toBe(1);
  }, 45_000);

  it('commits an inline edit and records it', async () => {
    await page.goto(`${app.origin}/app/tickets`);
    await page.waitForSelector('tr[data-ticket]');

    const row = page.locator('tr[data-ticket]').first();
    const id = Number(await row.getAttribute('data-ticket'));
    const before = app.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as { priority: string };
    const want = before.priority === 'Urgent' ? 'Low' : 'Urgent';

    await row.locator('td.editable[data-field=priority]').dblclick();
    await page.waitForSelector('td.editable select');
    await page.selectOption('td.editable select', want);
    await page.waitForSelector('.toast');

    const after = app.db.prepare('SELECT priority FROM tickets WHERE id = ?').get(id) as { priority: string };
    expect(after.priority).toBe(want);

    const entry = app.db
      .prepare("SELECT detail FROM audit WHERE action = 'ticket.update' AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(id)) as { detail: string };
    expect(entry.detail).toContain(`priority: ${before.priority} -> ${want}`);
  }, 45_000);

  it('opens and cancels the inline editor with the keyboard', async () => {
    await page.goto(`${app.origin}/app/tickets`);
    const cell = page.locator('td.editable[data-field=assignee]').first();
    const original = await cell.getAttribute('data-value');

    await cell.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('td.editable select');
    expect(await page.locator('td.editable select').inputValue()).toBe(original);

    await page.keyboard.press('Escape');
    expect(await page.locator('td.editable select').count()).toBe(0);
    expect(await cell.textContent()).toBe(original);
    expect(await cell.evaluate((node) => node === document.activeElement)).toBe(true);
  }, 45_000);
});

describe('query builder', () => {
  it('starts with one condition row and adds more on demand', async () => {
    await page.goto(`${app.origin}/app/reports/query`);
    expect(await page.locator('[data-frow]').count()).toBe(1);
    // The inputs for a second and third condition do not exist yet.
    expect(await page.locator('[aria-label="Field 3"]').count()).toBe(0);

    await page.click('#addrow');
    await page.click('#addrow');
    expect(await page.locator('[data-frow]').count()).toBe(3);
    expect(await page.locator('[aria-label="Field 3"]').count()).toBe(1);

    await page.locator('[data-removerow]').first().click();
    expect(await page.locator('[data-frow]').count()).toBe(2);
  }, 45_000);

  it('uses the correct value control after every field-type switch', async () => {
    await page.goto(`${app.origin}/app/reports/query`);
    await page.selectOption('[aria-label="Field 1"]', 'status');
    await page.waitForSelector('select[aria-label="Value 1"]');
    await page.selectOption('[aria-label="Value 1"]', 'Active');

    await page.selectOption('[aria-label="Field 1"]', 'city');
    expect(await page.locator('input[type=text][aria-label="Value 1"]').count()).toBe(1);
    expect(await page.inputValue('[aria-label="Value 1"]')).toBe('Active');

    await page.selectOption('[aria-label="Field 1"]', 'credit_limit');
    expect(await page.locator('input[type=number][aria-label="Value 1"]').count()).toBe(1);
    // The prior enum label is not a valid number and must not leak into the control.
    expect(await page.inputValue('[aria-label="Value 1"]')).toBe('');
  }, 45_000);

  it('does not execute a query encoded in a direct navigation URL', async () => {
    const before = Number(
      (
        app.db
          .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'report.query'")
          .get() as { n: number }
      ).n,
    );
    await page.goto(
      `${app.origin}/app/reports/query?match=all` +
        '&f_field=country&f_op=equals&f_value=Germany' +
        '&f_field=status&f_op=equals&f_value=Active' +
        '&f_field=credit_limit&f_op=%3E&f_value=30000&run=1',
    );

    expect(await page.locator('[data-frow]').count()).toBe(1);
    expect(await page.locator('#resultcount').count()).toBe(0);
    const after = Number(
      (
        app.db
          .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'report.query'")
          .get() as { n: number }
      ).n,
    );
    expect(after).toBe(before);
    expect(taskById('query-three-conditions')!.verify(app.db).passed).toBe(false);
  }, 45_000);

  it('runs a three-condition query and satisfies the task', async () => {
    await page.goto(`${app.origin}/app/reports/query`);
    await page.click('#addrow');
    await page.click('#addrow');

    await page.selectOption('[aria-label="Field 1"]', 'country');
    await page.selectOption('[aria-label="Operator 1"]', 'equals');
    await page.fill('[aria-label="Value 1"]', 'Germany');

    await page.selectOption('[aria-label="Field 2"]', 'status');
    // Changing the field to an enum replaces the value input with a select.
    await page.waitForSelector('select[aria-label="Value 2"]');
    await page.selectOption('[aria-label="Value 2"]', 'Active');
    await page.selectOption('[aria-label="Operator 2"]', 'equals');

    await page.selectOption('[aria-label="Field 3"]', 'credit_limit');
    await page.selectOption('[aria-label="Operator 3"]', '>');
    await page.fill('[aria-label="Value 3"]', '30000');

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/app/reports/query'),
    );
    await page.click('button[name=run]');
    const response = await responsePromise;
    expect(response.request().method()).toBe('POST');
    await page.waitForSelector('#resultcount');
    expect(await page.locator('select[aria-label="Value 2"]').count()).toBe(1);
    expect(await page.inputValue('[aria-label="Value 2"]')).toBe('Active');

    const verdict = taskById('query-three-conditions')!.verify(app.db);
    expect(verdict.passed, verdict.reason).toBe(true);
  }, 60_000);
});
