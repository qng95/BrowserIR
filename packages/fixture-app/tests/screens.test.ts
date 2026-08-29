import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';

let app: RunningAppServer;
let sid = '';

beforeAll(async () => {
  app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 200, vehicles: 3000 });
  const r = await fetch(app.origin + '/app/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=test&password=test',
    redirect: 'manual',
  });
  sid = /sid=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')![1]!;
});
afterAll(async () => {
  await app.close();
});

const get = (p: string) => fetch(app.origin + p, { headers: { cookie: `sid=${sid}` }, redirect: 'manual' });
const post = (p: string, form: Record<string, string>) =>
  fetch(app.origin + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `sid=${sid}` },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });

describe('inventory is genuinely virtualised', () => {
  it('ships only a window of rows, not the whole table', async () => {
    const page = await (await get('/app/vehicles')).text();
    const rows = page.match(/class="vrow" role="row"/g)?.length ?? 0;
    expect(rows).toBeLessThanOrEqual(40);
    expect(page).toContain('data-total="3000"');
    // The full height is expressed as a spacer, which is the only structural
    // evidence in the DOM that 3,000 rows exist.
    expect(page).toMatch(/vspacer" style="height:\d{4,}px/);
  });

  it('serves later windows over the API', async () => {
    const first = (await (await get('/api/vehicles?offset=0&limit=40')).json()) as { html: string };
    const later = (await (await get('/api/vehicles?offset=1200&limit=40')).json()) as {
      html: string;
      total: number;
    };
    expect(later.total).toBe(3000);
    expect(later.html).toContain('data-index="1200"');
    // Different window, different vehicles — the rows really are recycled.
    expect(later.html).not.toBe(first.html);
  });

  it('applies filters to the window and the count together', async () => {
    const d = (await (await get('/api/vehicles?status=Sold&offset=0&limit=10')).json()) as {
      total: number;
      html: string;
    };
    expect(d.total).toBeGreaterThan(0);
    expect(d.total).toBeLessThan(3000);
    expect(d.html).not.toContain('In stock');
  });

  it('opens a vehicle with a real nested browsing context', async () => {
    const page = await (await get('/app/vehicles/1')).text();
    expect(page).toContain('<iframe');
    expect(page).toContain('/legacy/valuation?vin=');

    const src = /src="(\/legacy\/valuation[^"]+)"/.exec(page)![1]!.replace(/&amp;/g, '&');
    const frame = await (await get(src)).text();
    // A separate document, not a srcdoc approximation.
    expect(frame).toContain('<!doctype html>');
    expect(frame).toContain('Trade-in base');
  });
});

describe('the order wizard is a real multi-step flow', () => {
  it('starts on the customer step with no options in the DOM', async () => {
    const page = await (await get('/app/orders/new')).text();
    expect(page).toContain('aria-current="step"');
    expect(page).toContain('role="combobox"');
    // The autocomplete list is empty until the agent types and waits.
    expect(page).toContain('id="cust-list" role="listbox" hidden');
  });

  it('will not advance without a customer', async () => {
    const r = await post('/app/orders/new', { step: 'customer' });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('Choose a customer before continuing');
  });

  it('requires two characters before the autocomplete returns anything', async () => {
    const one = (await (await get('/api/customers/search?q=a')).json()) as { items: unknown[] };
    const two = (await (await get('/api/customers/search?q=ad')).json()) as { items: unknown[] };
    expect(one.items).toHaveLength(0);
    expect(two.items.length).toBeGreaterThan(0);
  });

  it('carries earlier answers forward as hidden fields', async () => {
    const r = await post('/app/orders/new', { step: 'customer', customer_id: '1' });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain('name="customer_id" value="1"');
    expect(page).toContain('Choose vehicle…');
  });

  it('rejects a sold vehicle with a rule only discoverable by trying', async () => {
    const sold = app.db.prepare("SELECT id FROM vehicles WHERE status = 'Sold' LIMIT 1").get() as { id: number };
    const r = await post('/app/orders/new', {
      step: 'vehicle',
      customer_id: '1',
      vehicle_id: String(sold.id),
    });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('already sold');
  });

  it('enforces the earliest delivery date', async () => {
    const v = app.db.prepare("SELECT id FROM vehicles WHERE status = 'In stock' LIMIT 1").get() as { id: number };
    const r = await post('/app/orders/new', {
      step: 'details',
      customer_id: '1',
      vehicle_id: String(v.id),
      delivery_on: '2026-07-01',
    });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('Earliest available delivery date is 2026-08-01');
  });

  it('going back does not validate and does not lose answers', async () => {
    const r = await post('/app/orders/new', {
      step: 'details',
      back: '1',
      customer_id: '1',
      vehicle_id: '',
    });
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).not.toContain('Choose a vehicle before continuing');
    expect(page).toContain('name="customer_id" value="1"');
  });

  it('creates the order and reserves the vehicle on submit', async () => {
    const v = app.db.prepare("SELECT id FROM vehicles WHERE status = 'In stock' LIMIT 1").get() as { id: number };
    const r = await post('/app/orders/new', {
      step: 'review',
      customer_id: '1',
      vehicle_id: String(v.id),
      delivery_on: '2026-09-15',
      deposit: '5000',
      notes: 'Fleet livery',
    });
    expect(r.status).toBe(303);

    const veh = app.db.prepare('SELECT status FROM vehicles WHERE id = ?').get(v.id) as { status: string };
    expect(veh.status).toBe('Reserved');

    const line = app.db
      .prepare('SELECT * FROM order_lines WHERE vehicle_id = ?')
      .get(v.id) as Record<string, unknown> | undefined;
    expect(line, 'an order line should link the order to the vehicle').toBeDefined();

    const order = app.db
      .prepare('SELECT deposit_cents, notes FROM orders WHERE id = ?')
      .get(Number(line!['order_id'])) as { deposit_cents: number; notes: string };
    expect(order).toEqual({ deposit_cents: 500_000, notes: 'Fleet livery' });

    const acts = app.db
      .prepare("SELECT action FROM audit WHERE action IN ('order.create','vehicle.reserve')")
      .all() as Array<{ action: string }>;
    expect(acts.map((a) => a.action).sort()).toEqual(['order.create', 'vehicle.reserve']);
  });
});
