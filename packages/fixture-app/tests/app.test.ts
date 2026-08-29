import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startAppServer, type RunningAppServer } from '../src/server.js';
import { taskById } from '../src/tasks.js';

let app: RunningAppServer;
let sid = '';

beforeAll(async () => {
  // Zero latency in tests; the latency knob is exercised separately.
  app = await startAppServer({
    apiLatencyMs: 0,
    pageLatencyMs: 0,
    customers: 300,
    enableControlApi: true,
  });
});
afterAll(async () => {
  await app.close();
});

const get = (p: string, follow = false) =>
  fetch(app.origin + p, { headers: sid ? { cookie: `sid=${sid}` } : {}, redirect: follow ? 'follow' : 'manual' });

const post = (p: string, form: Record<string, string>) =>
  fetch(app.origin + p, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(sid ? { cookie: `sid=${sid}` } : {}),
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  });

async function loginTo(target: RunningAppServer): Promise<string> {
  const response = await fetch(`${target.origin}/app/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test', password: 'test' }),
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  const token = /sid=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  expect(token).toBeDefined();
  return token!;
}

async function startExport(target: RunningAppServer, token: string): Promise<string> {
  const response = await fetch(`${target.origin}/app/reports/export?jobMs=60000`, {
    method: 'POST',
    headers: { cookie: `sid=${token}` },
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const jobId = new URL(location!, target.origin).searchParams.get('job');
  expect(jobId).toBeTruthy();
  return jobId!;
}

describe('fixture network boundary', () => {
  it('binds the deliberately insecure fixture to IPv4 loopback', () => {
    expect(app.address).toMatchObject({
      address: '127.0.0.1',
      family: 'IPv4',
    });
  });

  it('rejects a loopback port collision promptly instead of hanging startup', async () => {
    const outcome = await Promise.race([
      startAppServer({
        port: app.address.port,
        apiLatencyMs: 0,
        pageLatencyMs: 0,
        customers: 1,
        vehicles: 1,
      }).then(
        () => ({ status: 'unexpectedly_started' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'timed_out' }>((resolve) =>
        setTimeout(() => resolve({ status: 'timed_out' }), 1_000),
      ),
    ]);

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toMatchObject({ code: 'EADDRINUSE' });
    }
  });

  it('does not expose grading or reset controls by default', async () => {
    const browserFacingApp = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 1,
      vehicles: 1,
    });

    try {
      const responses = await Promise.all([
        fetch(`${browserFacingApp.origin}/api/tasks`),
        fetch(`${browserFacingApp.origin}/api/tasks/verify`),
        fetch(`${browserFacingApp.origin}/api/tasks/create-customer/verify`),
        fetch(`${browserFacingApp.origin}/api/reset`, { method: 'POST' }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
        { error: 'not found' },
        { error: 'not found' },
        { error: 'not found' },
        { error: 'not found' },
      ]);
    } finally {
      await browserFacingApp.close();
    }
  });

  it('executes report queries only through the rendered POST form', async () => {
    const queryApp = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 100,
      vehicles: 100,
    });

    try {
      const login = await fetch(`${queryApp.origin}/app/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'test', password: 'test' }),
        redirect: 'manual',
      });
      const querySid = /sid=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
      expect(querySid).toBeDefined();

      const parameters = new URLSearchParams({ match: 'all' });
      for (const [field, operator, value] of [
        ['country', 'equals', 'Germany'],
        ['status', 'equals', 'Active'],
        ['credit_limit', '>', '30000'],
      ] as const) {
        parameters.append('f_field', field);
        parameters.append('f_op', operator);
        parameters.append('f_value', value);
      }
      parameters.set('run', '1');

      const directNavigation = await fetch(
        `${queryApp.origin}/app/reports/query?${parameters.toString()}`,
        { headers: { cookie: `sid=${querySid}` } },
      );
      expect(directNavigation.status).toBe(200);
      const directPage = await directNavigation.text();
      expect(directPage).not.toContain('id="resultcount"');
      expect(
        Number(
          (
            queryApp.db
              .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'report.query'")
              .get() as { n: number }
          ).n,
        ),
      ).toBe(0);
      expect(taskById('query-three-conditions')!.verify(queryApp.db).passed).toBe(false);

      const formSubmission = await fetch(`${queryApp.origin}/app/reports/query`, {
        method: 'POST',
        headers: {
          cookie: `sid=${querySid}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: parameters,
      });
      expect(formSubmission.status).toBe(200);
      expect(await formSubmission.text()).toContain('id="resultcount"');
      expect(taskById('query-three-conditions')!.verify(queryApp.db)).toMatchObject({
        outcome: 'passed',
        passed: true,
      });
    } finally {
      await queryApp.close();
    }
  });
});

describe('fixture server lifecycle isolation', () => {
  it('does not share sessions or jobs between running server instances', async () => {
    const first = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 5, vehicles: 5 });
    const second = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 5, vehicles: 5 });

    try {
      const firstSid = await loginTo(first);
      const crossServerSession = await fetch(`${second.origin}/app/customers`, {
        headers: { cookie: `sid=${firstSid}` },
        redirect: 'manual',
      });
      expect(crossServerSession.status).toBe(303);
      expect(crossServerSession.headers.get('location')).toContain('/app/login');

      const firstJob = await startExport(first, firstSid);
      await expect(fetch(`${first.origin}/api/jobs/${firstJob}`).then((response) => response.json())).resolves.toMatchObject({
        status: 'running',
      });
      await expect(fetch(`${second.origin}/api/jobs/${firstJob}`).then((response) => response.json())).resolves.toEqual({
        status: 'unknown',
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('reset clears only the receiving server instance', async () => {
    const first = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 5,
      vehicles: 5,
      enableControlApi: true,
    });
    const second = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      customers: 5,
      vehicles: 5,
      enableControlApi: true,
    });

    try {
      const [firstSid, secondSid] = await Promise.all([loginTo(first), loginTo(second)]);
      const [firstJob, secondJob] = await Promise.all([
        startExport(first, firstSid),
        startExport(second, secondSid),
      ]);

      const resetResponse = await fetch(`${first.origin}/api/reset`, { method: 'POST' });
      expect(resetResponse.status).toBe(200);

      const firstSession = await fetch(`${first.origin}/app/customers`, {
        headers: { cookie: `sid=${firstSid}` },
        redirect: 'manual',
      });
      const secondSession = await fetch(`${second.origin}/app/customers`, {
        headers: { cookie: `sid=${secondSid}` },
        redirect: 'manual',
      });
      expect(firstSession.status).toBe(303);
      expect(secondSession.status).toBe(200);
      await expect(fetch(`${first.origin}/api/jobs/${firstJob}`).then((response) => response.json())).resolves.toEqual({
        status: 'unknown',
      });
      await expect(fetch(`${second.origin}/api/jobs/${secondJob}`).then((response) => response.json())).resolves.toMatchObject({
        status: 'running',
      });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('keeps the database judgeable after the network barrier, then closes it exactly once', async () => {
    const disposable = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 1, vehicles: 1 });
    const firstStop = disposable.stopNetworkAccess();
    const concurrentStop = disposable.stopNetworkAccess();

    expect(concurrentStop).toBe(firstStop);
    await expect(firstStop).resolves.toBeUndefined();
    await expect(fetch(`${disposable.origin}/app/login`)).rejects.toThrow();
    expect(disposable.db.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });

    const firstClose = disposable.close();
    const concurrentClose = disposable.close();

    expect(concurrentClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(disposable.close()).resolves.toBeUndefined();
    expect(() => disposable.db.prepare('SELECT 1')).toThrow();
  });
});

describe('authentication is a real gate', () => {
  it('bounces an unauthenticated request to the login page', async () => {
    const r = await get('/app/customers');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('/app/login');
  });

  it('rejects wrong credentials', async () => {
    const r = await post('/app/login', { username: 'test', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain('Wrong username or password');
  });

  it('issues a session cookie on success', async () => {
    const r = await post('/app/login', { username: 'test', password: 'test' });
    expect(r.status).toBe(303);
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('sid=');
    sid = /sid=([^;]+)/.exec(cookie)![1]!;
  });
});

describe('the customer list is server-driven', () => {
  it('paginates', async () => {
    const p1 = await (await get('/app/customers?page=1')).text();
    const p2 = await (await get('/app/customers?page=2')).text();
    expect(p1).toContain('K-100000');
    expect(p2).not.toContain('>K-100000<');
    expect(p2).toContain('page 2 of');
  });

  it('sorts on the server, not in the browser', async () => {
    const asc = await (await get('/app/customers?sort=name&dir=asc')).text();
    const desc = await (await get('/app/customers?sort=name&dir=desc')).text();
    const first = (h: string) => /<td><a href="\/app\/customers\/\d+">([^<]+)<\/a>/.exec(h)?.[1];
    expect(first(asc)).not.toBe(first(desc));
    expect(asc).toContain('aria-sort="ascending"');
  });

  it('searches', async () => {
    const r = await (await get('/app/customers?q=Leipzig')).text();
    // Either matches exist or the empty state renders — both are server work.
    expect(r).toMatch(/customers · page|No customers match/);
  });

  it('renders an empty state rather than a blank table', async () => {
    const r = await (await get('/app/customers?q=zzzznotathing')).text();
    expect(r).toContain('No customers match that filter');
  });
});

describe('mutations go through post-redirect-get and server validation', () => {
  it('rejects an invalid create and re-renders with field errors', async () => {
    const r = await post('/app/customers/new', {
      name: 'X',
      city: '',
      country: 'Germany',
      status: 'Prospect',
      credit_limit: '400000',
      vat_id: 'nope',
    });
    expect(r.status).toBe(422);
    const body = await r.text();
    expect(body).toContain('at least 3 characters');
    expect(body).toContain('City is required');
    expect(body).toContain('needs board approval');
    expect(body).toContain('two letters followed by 9 digits');
    // The user's input must survive the round trip, or correcting one field
    // would mean retyping the rest.
    expect(body).toContain('value="400000"');
  });

  it('creates on valid input and redirects to the new record', async () => {
    const r = await post('/app/customers/new', {
      name: 'Testhaus Berlin GmbH',
      city: 'Berlin',
      country: 'Germany',
      status: 'Prospect',
      credit_limit: '12000',
      vat_id: 'DE123456789',
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get('location')!;
    expect(loc).toMatch(/^\/app\/customers\/\d+$/);
    const detail = await (await get(loc)).text();
    expect(detail).toContain('Testhaus Berlin GmbH');
    expect(detail).toContain('Berlin');
  });

  it('refuses a duplicate name', async () => {
    const r = await post('/app/customers/new', {
      name: 'Testhaus Berlin GmbH',
      city: 'Berlin',
      country: 'Germany',
      status: 'Prospect',
      credit_limit: '12000',
    });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain('already exists');
  });

  it('records every mutation in the audit log', async () => {
    const r = await (await get('/app/reports/audit')).text();
    expect(r).toContain('customer.create');
  });
});

describe('panels load lazily over the API', () => {
  it('serves the detail page with a skeleton, not the data', async () => {
    const page = await (await get('/app/customers/1/contacts')).text();
    expect(page).toContain('data-state="loading"');
    expect(page).toContain('class="skeleton"');
    expect(page).toContain("fetch('/api/customers/1/contacts'");
    // The rows are NOT in the initial document.
    expect(page).not.toContain('<th>Email</th>');
  });

  it('returns the rows from the API', async () => {
    const data = (await (await get('/api/customers/1/contacts')).json()) as { count: number; html: string };
    expect(data.count).toBeGreaterThan(0);
    expect(data.html).toContain('<th>Email</th>');
  });

  it('honours the latency override', async () => {
    const t0 = Date.now();
    await get('/api/customers/1/orders?latency=300');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });
});

describe('tasks are graded against the database, not the page', () => {
  it('reports every task as failing on a fresh database', async () => {
    const { results } = (await (await get('/api/tasks/verify')).json()) as {
      results: Array<{ id: string; passed: boolean }>;
    };
    // A task that passes before anyone does anything is not measuring work.
    expect(results.filter((r) => r.passed).map((r) => r.id)).toEqual([]);
  });

  it('passes create-customer only once the record actually exists', async () => {
    expect(taskById('create-customer')!.verify(app.db).passed).toBe(false);
    await post('/app/customers/new', {
      name: 'Steinweg Logistik GmbH',
      city: 'Leipzig',
      country: 'Germany',
      status: 'Prospect',
      credit_limit: '30000',
      vat_id: 'DE145879632',
    });
    const after = taskById('create-customer')!.verify(app.db);
    expect(after.passed, after.reason).toBe(true);
  });

  it('fails a half-done task with a reason naming the wrong field', async () => {
    await post('/app/customers/new', {
      name: 'Nordlicht Spedition',
      city: 'Bremen',
      country: 'Germany',
      status: 'Prospect',
      credit_limit: '100000',
    });
    const r = taskById('validation-recovery')!.verify(app.db);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('maximum the server accepts is 250000');
  });

  it('will not pass an edit task on value alone without a recorded action', async () => {
    // Force the target value directly in the database, bypassing the app.
    app.db.prepare("UPDATE customers SET credit_limit = 45000 WHERE number = 'K-100042'").run();
    const r = taskById('raise-credit-limit')!.verify(app.db);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('no update was ever recorded');
  });

  it('passes the edit task when the change goes through the app', async () => {
    const id = (app.db.prepare("SELECT id FROM customers WHERE number = 'K-100042'").get() as { id: number }).id;
    // The preceding negative test deliberately bypassed the app. Restore the
    // seeded value so this positive case proves a real 41000 -> 45000 edit.
    app.db.prepare('UPDATE customers SET credit_limit = 41000 WHERE id = ?').run(id);
    const existing = app.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, string>;
    const r = await post(`/app/customers/${id}/edit`, {
      name: String(existing['name']),
      city: String(existing['city']),
      country: String(existing['country']),
      status: String(existing['status']),
      credit_limit: '45000',
      vat_id: String(existing['vat_id'] ?? ''),
    });
    expect(r.status).toBe(303);
    const v = taskById('raise-credit-limit')!.verify(app.db);
    expect(v.passed, v.reason).toBe(true);
  });
});

describe('reset restores a known state', () => {
  it('clears everything the tests did', async () => {
    const r = await fetch(app.origin + '/api/reset', { method: 'POST' });
    expect(r.status).toBe(200);
    const { results } = (await (await fetch(app.origin + '/api/tasks/verify')).json()) as {
      results: Array<{ passed: boolean }>;
    };
    expect(results.every((x) => !x.passed)).toBe(true);
  });
});
