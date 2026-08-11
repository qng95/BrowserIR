import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';

/**
 * Drag and drop, and a three-pane master-detail.
 *
 * Dragging is the one interaction common in enterprise software that has no
 * accessible-tree representation at all: the drop target only advertises itself
 * mid-drag, and the operation cannot be performed by clicking. The scheduler
 * therefore also offers a keyboard route, and records which one was used, so an
 * agent that cannot drag is measurably different from one that can.
 */
let app: RunningAppServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  app = await startAppServer({ apiLatencyMs: 50, pageLatencyMs: 0, customers: 120, vehicles: 300 });
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

type Appt = { id: number; bay_id: number; day: string; slot: number };

describe('workshop scheduler', () => {
  it('renders a bay/slot grid with draggable appointments', async () => {
    await page.goto(`${app.origin}/app/workshop`);
    await page.waitForSelector('.appt');
    expect(await page.locator('.appt[draggable=true]').count()).toBeGreaterThan(0);
    expect(await page.locator('td.free[data-drop]').count()).toBeGreaterThan(0);
  }, 30_000);

  it('only empty cells accept a drop, and only while dragging', async () => {
    await page.goto(`${app.origin}/app/workshop`);
    await page.waitForSelector('.appt');
    // Nothing advertises itself as a drop target until a drag is in flight.
    expect(await page.locator('td.over').count()).toBe(0);
    // A filled cell is not a drop target at all.
    expect(await page.locator('td.filled[data-drop]').count()).toBe(0);
  }, 30_000);

  it('moves an appointment by dragging it onto an empty slot', async () => {
    await page.goto(`${app.origin}/app/workshop`);
    await page.waitForSelector('.appt');

    const card = page.locator('.appt').first();
    const apptId = Number(await card.getAttribute('data-appt'));
    const before = app.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId) as Appt;

    const target = page.locator('td.free[data-drop]').first();
    const want = {
      bay: Number(await target.getAttribute('data-bay')),
      day: String(await target.getAttribute('data-day')),
      slot: Number(await target.getAttribute('data-slot')),
    };

    // Driven with explicit mouse steps rather than dragTo(): this is what a
    // CDP-controlled agent actually emits, and it exercises the pointer path
    // that HTML5 drag-and-drop alone leaves unreachable.
    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    // Already on /app/workshop, so waitForURL would resolve instantly and race
    // the POST. The toast only exists after the redirect has been served.
    await page.waitForSelector('.toast', { timeout: 15_000 });

    const after = app.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId) as Appt;
    expect({ bay: after.bay_id, day: after.day, slot: after.slot }).toEqual(want);
    expect(after).not.toEqual(before);

    const entry = app.db
      .prepare("SELECT detail FROM audit WHERE action = 'appointment.move' AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(apptId)) as { detail: string };
    expect(entry.detail).toContain('via drag');
  }, 60_000);

  it('offers a keyboard route, recorded separately from dragging', async () => {
    await page.goto(`${app.origin}/app/workshop`);
    await page.waitForSelector('.appt');

    const card = page.locator('.appt').nth(1);
    const apptId = Number(await card.getAttribute('data-appt'));

    await card.focus();
    await page.keyboard.press('Enter');
    expect(await page.textContent('#schedhint')).toContain('picked up');

    // Addressed by its coordinates rather than by index: nth() is ambiguous
    // once an earlier test has already moved something into a free cell.
    const cellAttrs = await page.locator('td.free[data-drop]').nth(2).evaluate((td) => ({
      bay: Number(td.getAttribute('data-bay')),
      day: String(td.getAttribute('data-day')),
      slot: Number(td.getAttribute('data-slot')),
    }));
    const want = cellAttrs;
    const target = page.locator(
      `td.free[data-bay="${want.bay}"][data-day="${want.day}"][data-slot="${want.slot}"]`,
    );
    await target.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.toast', { timeout: 15_000 });

    const after = app.db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId) as Appt;
    expect({ bay: after.bay_id, day: after.day, slot: after.slot }).toEqual(want);

    const entry = app.db
      .prepare("SELECT detail FROM audit WHERE action = 'appointment.move' AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(apptId)) as { detail: string };
    expect(entry.detail).toContain('via keyboard');
  }, 60_000);

  it('refuses a move onto an occupied slot', async () => {
    const occupied = app.db
      .prepare('SELECT * FROM appointments ORDER BY id LIMIT 2')
      .all() as Appt[];
    const [a, b] = occupied;

    const res = await fetch(`${app.origin}/app/workshop/move`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; '),
      },
      body: new URLSearchParams({
        appointment_id: String(a!.id),
        bay_id: String(b!.bay_id),
        day: b!.day,
        slot: String(b!.slot),
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);

    const still = app.db.prepare('SELECT * FROM appointments WHERE id = ?').get(a!.id) as Appt;
    expect({ bay: still.bay_id, day: still.day, slot: still.slot }).toEqual({
      bay: a!.bay_id,
      day: a!.day,
      slot: a!.slot,
    });
  }, 30_000);
});

describe('parts master-detail', () => {
  it('renders collapsed branches with no children in the DOM', async () => {
    await page.goto(`${app.origin}/app/parts`);
    await page.waitForSelector('.mdtree');
    expect(await page.locator('.mdtree [aria-expanded=true]').count()).toBe(0);
    expect(await page.locator('.mdtree .nav-children a').count()).toBe(0);
    expect(await page.textContent('.mdlist')).toContain('Choose a category');
  }, 30_000);

  it('takes three navigations to reach a part', async () => {
    await page.goto(`${app.origin}/app/parts`);
    // 1. open a top-level branch. Root categories hold no parts themselves —
    //    only leaves do — so the list pane is still empty here.
    await page.locator('.mdtree .nav-head').first().click();
    await page.waitForSelector('.mdtree .nav-children a');
    expect(await page.textContent('.mdlist')).toContain('No parts in this category');

    // 2. choose a leaf category to populate the list pane.
    await page.locator('.mdtree .nav-children a').first().click();
    await page.waitForSelector('.mdlist tbody tr');
    expect(await page.textContent('.mddetail')).toContain('Select a part');

    await page.locator('.mdlist tbody tr td a').first().click();
    await page.waitForSelector('.mddetail .card');
    expect(await page.locator('.mdlist tr[aria-selected=true]').count()).toBe(1);
  }, 45_000);

  it('restocks a part and records it', async () => {
    const part = app.db.prepare('SELECT * FROM parts ORDER BY id LIMIT 1').get() as {
      id: number;
      category_id: number;
      stock: number;
      sku: string;
    };
    await page.goto(`${app.origin}/app/parts?category=${part.category_id}&part=${part.id}`);
    await page.waitForSelector('#qty');
    await page.fill('#qty', '35');
    await page.click('.mddetail button.primary');
    await page.waitForSelector('.toast');

    const after = app.db.prepare('SELECT stock FROM parts WHERE id = ?').get(part.id) as { stock: number };
    expect(after.stock).toBe(part.stock + 35);

    const entry = app.db
      .prepare("SELECT detail FROM audit WHERE action = 'part.restock' AND entity_id = ?")
      .get(String(part.id)) as { detail: string };
    expect(entry.detail).toContain('+35');
  }, 45_000);

  it('flags parts below their reorder level', async () => {
    const low = app.db
      .prepare('SELECT * FROM parts WHERE stock < reorder_level ORDER BY id LIMIT 1')
      .get() as { category_id: number } | undefined;
    expect(low, 'the seed should contain at least one understocked part').toBeDefined();
    await page.goto(`${app.origin}/app/parts?category=${low!.category_id}`);
    await page.waitForSelector('.mdlist tbody tr');
    expect(await page.locator('td.low').count()).toBeGreaterThan(0);
  }, 30_000);
});
