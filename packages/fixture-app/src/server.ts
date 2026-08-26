import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

import { audit, createDb, money, reset } from './db.js';
import { clearCookie, html, json, latencyFor, parseCookies, readBody, readForm, redirect, setCookie, sleep } from './http.js';
import {
  auditPage,
  customerDetailPage,
  customerFormPage,
  customerListPage,
  loginPage,
  notFoundPage,
  placeholderPage,
  revenuePage,
  validateCustomer,
  type PageCtx,
} from './pages.js';
import { TASKS, taskById, verifyAll } from './tasks.js';
import {
  countVehicles,
  legacyValuationPage,
  parseVehicleQuery,
  sliceVehicles,
  vehicleDetailPage,
  vehicleRowHtml,
  vehiclesPage,
  WINDOW,
} from './vehicles.js';
import { BULK_ACTIONS, ordersPage } from './orders.js';
import { clearJobs, exportPage, jobState, startJob } from './jobs.js';
import { partsPage, workshopPage } from './workshop.js';
import {
  INVOICE_STATUSES, TICKET_PRIORITIES, TICKET_STATUSES, ASSIGNEES,
  invoiceDetailPage, invoicePrintPage, invoicesPage, ticketsPage,
} from './billing.js';
import { applyFilters, dashboardPage, dashboardTile, filterBuilderPage, parseFilters } from './reports.js';
import { STEPS, validateStep, wizardPage, type Step } from './wizard.js';
import { esc } from './views.js';
import {
  adaptiveAccuracyHoldoutCases,
  adaptiveAccuracyHoldoutPage,
  isAdaptiveAccuracyHoldoutTarget,
  recordAdaptiveAccuracyHoldoutSelection,
  resolveAdaptiveAccuracyHoldoutBinding,
  type AdaptiveAccuracyHoldoutBinding,
} from './adaptive-accuracy-holdout.js';

type Row = Record<string, unknown>;

export interface AppServerOptions {
  port?: number;
  /**
   * Expose the fixture's grading and reset HTTP endpoints.
   *
   * Disabled by default so a browser agent cannot inspect the task oracle or
   * reset shared state through the same origin it is being evaluated against.
   * Prefer verifying tasks directly against `RunningAppServer.db`.
   */
  enableControlApi?: boolean;
  /** Default artificial latency for API calls, in ms. Overridable per request. */
  apiLatencyMs?: number;
  /** Default artificial latency for page loads, in ms. */
  pageLatencyMs?: number;
  seed?: number;
  customers?: number;
  vehicles?: number;
  /** Bind one v2 accuracy-development site route to a hidden server-side world. */
  adaptiveAccuracyHoldout?: AdaptiveAccuracyHoldoutBinding;
}

export interface RunningAppServer {
  origin: string;
  address: AddressInfo;
  db: DatabaseSync;
  close(): Promise<void>;
}

/** Sessions live in process memory; the fixture is disposable by design. */
const sessions = new Map<string, string>();

function newToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function startAppServer(options: AppServerOptions = {}): Promise<RunningAppServer> {
  const seedOpts = {
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.customers !== undefined ? { customers: options.customers } : {}),
    ...(options.vehicles !== undefined ? { vehicles: options.vehicles } : {}),
  };
  const db = createDb(seedOpts);
  const apiLatency = options.apiLatencyMs ?? 450;
  const pageLatency = options.pageLatencyMs ?? 120;
  const controlApiEnabled = options.enableControlApi === true;
  const adaptiveAccuracyHoldout = options.adaptiveAccuracyHoldout === undefined
    ? undefined
    : resolveAdaptiveAccuracyHoldoutBinding(options.adaptiveAccuracyHoldout);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const cookies = parseCookies(req);
    const username = cookies['sid'] ? sessions.get(cookies['sid']) : undefined;
    const user = username
      ? (db.prepare('SELECT username, display_name FROM users WHERE username = ?').get(username) as
          | { username: string; display_name: string }
          | undefined)
      : undefined;

    const flashRaw = cookies['flash'];
    let flash: PageCtx['flash'];
    if (flashRaw) {
      try {
        flash = JSON.parse(flashRaw) as PageCtx['flash'];
      } catch {
        flash = undefined;
      }
      clearCookie(res, 'flash');
    }
    const ctx: PageCtx = { db, path, url, user, flash };
    const actor = user?.username ?? 'anonymous';

    const setFlash = (kind: 'ok' | 'error', text: string) =>
      setCookie(res, 'flash', JSON.stringify({ kind, text }), 30);

    // ---------------------------------------------------------------- API --
    if (path.startsWith('/api/')) {
      await sleep(latencyFor(url, apiLatency));

      let m = /^\/api\/customers\/(\d+)\/(contacts|orders)$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        if (m[2] === 'contacts') {
          const rows = db.prepare('SELECT * FROM contacts WHERE customer_id = ? ORDER BY id').all(id) as Row[];
          return json(res, {
            count: rows.length,
            html: rows.length
              ? `<table><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th></tr></thead><tbody>${rows
                  .map(
                    (r) =>
                      `<tr><td>${esc(r['name'])}</td><td>${esc(r['role'])}</td>` +
                      `<td><a href="mailto:${esc(r['email'])}">${esc(r['email'])}</a></td><td>${esc(r['phone'])}</td></tr>`,
                  )
                  .join('')}</tbody></table>`
              : `<p class="empty">No contacts recorded.</p>`,
          });
        }
        const rows = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY placed_on DESC').all(id) as Row[];
        return json(res, {
          count: rows.length,
          html: rows.length
            ? `<table><thead><tr><th>Order</th><th>Placed</th><th>Vehicle</th><th>Status</th><th>Total</th></tr></thead><tbody>${rows
                .map(
                  (r) =>
                    `<tr><td>${esc(r['number'])}</td><td>${esc(r['placed_on'])}</td><td>${esc(r['vehicle'])}</td>` +
                    `<td>${esc(r['status'])}</td><td class="num">${money(Number(r['total_cents']))}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : `<p class="empty">No orders recorded.</p>`,
        });
      }

      // Windowed inventory rows for the virtualised grid.
      if (path === '/api/vehicles') {
        const q = parseVehicleQuery(url);
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0') || 0);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? String(WINDOW)) || WINDOW));
        const rows = sliceVehicles(db, q, offset, limit);
        return json(res, {
          offset,
          total: countVehicles(db, q),
          html: rows.map((v, i) => vehicleRowHtml(v, offset + i)).join(''),
        });
      }

      if (path === '/api/vehicles/pick') {
        const term = (url.searchParams.get('q') ?? '').trim();
        const like = `%${term}%`;
        const rows = (
          term
            ? db
                .prepare(
                  'SELECT * FROM vehicles WHERE vin LIKE ? OR make LIKE ? OR model LIKE ? ORDER BY id LIMIT 25',
                )
                .all(like, like, like)
            : db.prepare('SELECT * FROM vehicles ORDER BY id LIMIT 25').all()
        ) as Row[];
        return json(res, {
          items: rows.map((v) => ({
            id: v['id'],
            vin: v['vin'],
            make: v['make'],
            model: v['model'],
            variant: v['variant'],
            status: v['status'],
            price: money(Number(v['price_cents'])),
          })),
        });
      }

      if (path === '/api/customers/search') {
        const term = (url.searchParams.get('q') ?? '').trim();
        if (term.length < 2) return json(res, { items: [] });
        const like = `%${term}%`;
        const rows = db
          .prepare('SELECT id, number, name, city FROM customers WHERE name LIKE ? OR number LIKE ? ORDER BY name LIMIT 12')
          .all(like, like) as Row[];
        return json(res, { items: rows });
      }

      let dm = /^\/api\/dashboard\/([\w-]+)$/.exec(path);
      if (dm) {
        const tile = dashboardTile(db, dm[1]!);
        return tile ? json(res, tile) : json(res, { error: 'unknown tile' }, 404);
      }

      let jm = /^\/api\/jobs\/(\w+)$/.exec(path);
      if (jm) {
        const st = jobState(jm[1]!);
        if (st.status === 'unknown') return json(res, { status: 'unknown' });
        return json(res, { status: st.status, percent: st.percent, rows: st.job.rows });
      }

      if (controlApiEnabled) {
        if (path === '/api/tasks' && method === 'GET') {
          return json(res, TASKS.map((t) => ({ id: t.id, prompt: t.prompt, skills: t.skills })));
        }
        if (path === '/api/tasks/verify' && method === 'GET') {
          return json(res, { results: verifyAll(db) });
        }
        m = /^\/api\/tasks\/([\w-]+)\/verify$/.exec(path);
        if (m && method === 'GET') {
          const t = taskById(m[1]!);
          if (!t) return json(res, { error: 'unknown task' }, 404);
          return json(res, { id: t.id, ...t.verify(db) });
        }
        if (path === '/api/reset' && method === 'POST') {
          reset(db, seedOpts);
          sessions.clear();
          clearJobs();
          return json(res, { ok: true, message: 'Database restored to seed state.' });
        }
      }
      return json(res, { error: 'not found' }, 404);
    }

    // -------------------------------------------------------------- pages --
    await sleep(latencyFor(url, pageLatency));

    if (path === '/' ) return redirect(res, '/app/customers');

    if (path === '/app/login') {
      if (method === 'GET') return html(res, loginPage(ctx));
      const form = await readForm(req);
      const found = db
        .prepare('SELECT * FROM users WHERE username = ? AND password = ?')
        .get(form['username'] ?? '', form['password'] ?? '') as Row | undefined;
      if (!found) return html(res, loginPage(ctx, 'Wrong username or password.'), 401);
      const token = newToken();
      sessions.set(token, String(found['username']));
      setCookie(res, 'sid', token);
      return redirect(res, form['next'] || '/app/customers');
    }

    if (path === '/app/logout' && method === 'POST') {
      if (cookies['sid']) sessions.delete(cookies['sid']);
      clearCookie(res, 'sid');
      return redirect(res, '/app/login');
    }

    // Everything below requires a session. An agent that skips the sign-in
    // step gets bounced here, which is a realistic first hurdle.
    if (path.startsWith('/app/') && !user) {
      return redirect(res, `/app/login?next=${encodeURIComponent(path + url.search)}`);
    }

    // The accuracy study uses a separate v2 catalog and audit
    // namespace. Its case/world binding exists only in this server closure;
    // neither the stable route nor the submitted form can select a world.
    if (adaptiveAccuracyHoldout !== undefined) {
      const study = adaptiveAccuracyHoldoutCases[adaptiveAccuracyHoldout.caseId];
      if (path === study.path || path === study.selectionPath) {
        if (path === study.path && method === 'GET') {
          return html(res, adaptiveAccuracyHoldoutPage(ctx, adaptiveAccuracyHoldout));
        }
        if (path === study.selectionPath && method === 'POST') {
          const form = await readForm(req);
          const target = form['target'] ?? '';
          if (!isAdaptiveAccuracyHoldoutTarget(study.caseId, target)) {
            setFlash('error', 'That holdout action is no longer available.');
            return redirect(res, study.path);
          }
          recordAdaptiveAccuracyHoldoutSelection(
            db,
            actor,
            adaptiveAccuracyHoldout,
            target,
          );
          setFlash('ok', 'Holdout action recorded.');
          return redirect(res, study.path);
        }
        return html(res, notFoundPage(ctx), 404);
      }
    }

    if (path === '/app/customers' && method === 'GET') return html(res, customerListPage(ctx));

    if (path === '/app/customers/new') {
      if (method === 'GET') {
        return html(res, customerFormPage(ctx, 'new', null, { values: { status: 'Prospect' }, errors: {} }));
      }
      const values = await readForm(req);
      const errors = validateCustomer(values, db);
      if (Object.keys(errors).length) {
        const attemptedCreditLimit = Number(values['credit_limit']);
        if (
          errors['credit_limit'] === 'Credit limit above 250.000 € needs board approval.' &&
          Number.isFinite(attemptedCreditLimit)
        ) {
          const name = (values['name'] ?? '').trim();
          audit(db, {
            actor,
            action: 'customer.create.rejected',
            entity: 'customer',
            entityId: name || 'new',
            detail: JSON.stringify({
              reason: 'credit_limit_above_ceiling',
              name,
              attemptedCreditLimit,
              maximumCreditLimit: 250000,
            }),
          });
        }
        return html(res, customerFormPage(ctx, 'new', null, { values, errors }), 422);
      }
      const count = Number((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as Row).n);
      const info = db
        .prepare(
          `INSERT INTO customers (number,name,status,city,country,owner,segment,credit_limit,revenue,
             vat_id,street,postal_code,last_contact,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `K-${100000 + count}`,
          values['name']!.trim(),
          values['status'] ?? 'Prospect',
          values['city']!.trim(),
          values['country']!.trim(),
          user!.display_name,
          'Retail',
          Number(values['credit_limit']),
          0,
          (values['vat_id'] ?? '').trim() || null,
          null,
          null,
          new Date().toISOString().slice(0, 10),
          new Date().toISOString().slice(0, 10),
        );
      const id = Number(info.lastInsertRowid);
      audit(db, { actor, action: 'customer.create', entity: 'customer', entityId: id, detail: values['name'] ?? '' });
      setFlash('ok', `Customer "${values['name']}" created.`);
      return redirect(res, `/app/customers/${id}`);
    }

    let m = /^\/app\/customers\/(\d+)(?:\/(contacts|orders|edit))?$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const sub = m[2];

      if (sub === 'edit') {
        const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Row | undefined;
        if (!existing) return html(res, notFoundPage(ctx), 404);

        if (method === 'GET') {
          return html(
            res,
            customerFormPage(ctx, 'edit', id, {
              values: {
                name: String(existing['name']),
                city: String(existing['city']),
                country: String(existing['country']),
                status: String(existing['status']),
                credit_limit: String(existing['credit_limit']),
                vat_id: String(existing['vat_id'] ?? ''),
              },
              errors: {},
            }),
          );
        }
        const values = await readForm(req);
        const errors = validateCustomer(values, db, id);
        if (Object.keys(errors).length) {
          return html(res, customerFormPage(ctx, 'edit', id, { values, errors }), 422);
        }
        const nextValues: Row = {
          name: values['name']!.trim(),
          city: values['city']!.trim(),
          country: values['country']!.trim(),
          status: values['status'] ?? String(existing['status']),
          credit_limit: Number(values['credit_limit']),
          vat_id: (values['vat_id'] ?? '').trim() || null,
        };
        const trackedFields = ['name', 'city', 'country', 'status', 'credit_limit', 'vat_id'] as const;
        const changed = trackedFields.filter((field) => existing[field] !== nextValues[field]);
        db.prepare(
          'UPDATE customers SET name=?, city=?, country=?, status=?, credit_limit=?, vat_id=? WHERE id=?',
        ).run(
          nextValues['name'] as string,
          nextValues['city'] as string,
          nextValues['country'] as string,
          nextValues['status'] as string,
          nextValues['credit_limit'] as number,
          nextValues['vat_id'] as string | null,
          id,
        );
        audit(db, {
          actor,
          action: 'customer.update',
          entity: 'customer',
          entityId: id,
          detail: JSON.stringify({
            changed,
            before: Object.fromEntries(trackedFields.map((field) => [field, existing[field]])),
            after: Object.fromEntries(trackedFields.map((field) => [field, nextValues[field]])),
          }),
        });
        setFlash('ok', 'Changes saved.');
        return redirect(res, `/app/customers/${id}`);
      }

      return html(res, customerDetailPage(ctx, id, sub ?? 'overview'));
    }

    m = /^\/app\/orders\/(\d+)\/deliver$/.exec(path);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
      if (!o) return html(res, notFoundPage(ctx), 404);
      db.prepare("UPDATE orders SET status = 'Delivered' WHERE id = ?").run(id);
      audit(db, {
        actor,
        action: 'order.deliver',
        entity: 'order',
        entityId: id,
        detail: `${String(o['status'])} -> Delivered`,
      });
      setFlash('ok', `Order ${String(o['number'])} marked delivered.`);
      return redirect(res, req.headers.referer ?? '/app/orders');
    }

    // ---- inventory --------------------------------------------------------
    if (path === '/app/vehicles' && method === 'GET') return html(res, vehiclesPage(ctx));
    m = /^\/app\/vehicles\/(\d+)\/status$/.exec(path);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as Row | undefined;
      if (!v) return html(res, notFoundPage(ctx), 404);
      const form = await readForm(req);
      const next = form['status'] ?? '';
      if (!['In stock', 'Reserved', 'In transit', 'Sold', 'Demo'].includes(next)) {
        setFlash('error', 'Unknown status.');
        return redirect(res, `/app/vehicles/${id}`);
      }
      db.prepare('UPDATE vehicles SET status = ? WHERE id = ?').run(next, id);
      audit(db, {
        actor,
        action: 'vehicle.status',
        entity: 'vehicle',
        entityId: id,
        detail: `${String(v['status'])} → ${next}`,
      });
      setFlash('ok', `${String(v['vin'])} is now ${next}.`);
      return redirect(res, `/app/vehicles/${id}`);
    }

    m = /^\/app\/vehicles\/(\d+)$/.exec(path);
    if (m) return html(res, vehicleDetailPage(ctx, Number(m[1])));

    // ---- order wizard -----------------------------------------------------
    if (path === '/app/orders/new') {
      if (method === 'GET') {
        return html(res, wizardPage(ctx, { step: 'customer', values: {}, errors: {} }));
      }
      const form = await readForm(req);
      const submitted = (STEPS as readonly string[]).includes(form['step'] ?? '')
        ? (form['step'] as Step)
        : 'customer';
      const idx = STEPS.indexOf(submitted);
      const values = { ...form };
      delete values['step'];
      delete values['back'];

      if (form['back']) {
        // Going back must not validate — a half-filled later step should never
        // block returning to an earlier one.
        return html(res, wizardPage(ctx, { step: STEPS[Math.max(0, idx - 1)]!, values, errors: {} }));
      }

      const errors = validateStep(submitted, values, db);
      if (Object.keys(errors).length) {
        return html(res, wizardPage(ctx, { step: submitted, values, errors }), 422);
      }
      if (submitted !== 'review') {
        return html(res, wizardPage(ctx, { step: STEPS[idx + 1]!, values, errors: {} }));
      }

      // Final step: create the order, reserve the vehicle, audit both.
      const veh = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(values['vehicle_id'])) as Row;
      const seq = Number((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as Row).n) + 1;
      const number = `A-2026-${String(seq).padStart(4, '0')}`;
      const info = db
        .prepare(
          `INSERT INTO orders
           (customer_id,number,placed_on,delivery_on,vehicle,status,total_cents)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          Number(values['customer_id']),
          number,
          new Date().toISOString().slice(0, 10),
          values['delivery_on'] ?? '',
          `${String(veh['make'])} ${String(veh['model'])} ${String(veh['variant'])}`,
          'Confirmed',
          Number(veh['price_cents']),
        );
      const orderId = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO order_lines (order_id,vehicle_id,description,qty,unit_cents) VALUES (?,?,?,?,?)').run(
        orderId,
        Number(veh['id']),
        `${String(veh['make'])} ${String(veh['model'])} — ${String(veh['vin'])}`,
        1,
        Number(veh['price_cents']),
      );
      db.prepare("UPDATE vehicles SET status = 'Reserved' WHERE id = ?").run(Number(veh['id']));
      audit(db, { actor, action: 'order.create', entity: 'order', entityId: orderId, detail: number });
      audit(db, {
        actor,
        action: 'vehicle.reserve',
        entity: 'vehicle',
        entityId: Number(veh['id']),
        detail: `In stock -> Reserved; order ${number}`,
      });
      setFlash('ok', `Order ${number} created and vehicle reserved.`);
      return redirect(res, '/app/orders');
    }

    if (path === '/app/orders/bulk' && method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const action = params.get('bulk_action') ?? '';
      const operationScope = params.get('operation_scope') ?? '';
      const ids = params.getAll('ids').map(Number).filter(Number.isFinite);
      const next = BULK_ACTIONS[action];
      if (!next || ids.length === 0) {
        setFlash('error', 'Nothing to do.');
        return redirect(res, req.headers.referer ?? '/app/orders');
      }
      const upd = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
      const transitions: Array<{ id: number; before: string; after: string }> = [];
      for (const id of ids) {
        const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
        if (!o) continue;
        const before = String(o['status']);
        upd.run(next, id);
        audit(db, {
          actor,
          action: action === 'deliver' ? 'order.deliver' : `order.${action}`,
          entity: 'order',
          entityId: id,
          detail: `${before} -> ${next}`,
        });
        transitions.push({ id, before, after: next });
      }
      if (operationScope === 'bulk' && transitions.length > 0) {
        audit(db, {
          actor,
          action: `order.bulk.${action}`,
          entity: 'orders',
          entityId: transitions.length,
          detail: JSON.stringify({
            action,
            ids: transitions.map((transition) => transition.id),
            transitions,
          }),
        });
      }
      setFlash('ok', `${ids.length} order(s) set to ${next}.`);
      return redirect(res, req.headers.referer ?? '/app/orders');
    }

    if (path === '/app/reports/export') {
      if (method === 'GET') return html(res, exportPage(ctx, url.searchParams.get('job') ?? undefined));
      const rows = Number((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as Row).n);
      const job = startJob('customers', rows, Number(url.searchParams.get('jobMs') ?? '6000'));
      audit(db, { actor, action: 'report.export', entity: 'job', entityId: job.id, detail: `${rows} rows` });
      return redirect(res, `/app/reports/export?job=${job.id}`);
    }

    let em = /^\/app\/reports\/export\/(\w+)\/download$/.exec(path);
    if (em) {
      const st = jobState(em[1]!);
      if (st.status !== 'done') {
        setFlash('error', 'That export is not finished yet.');
        return redirect(res, '/app/reports/export');
      }
      const rows = db.prepare('SELECT number,name,status,city,country FROM customers LIMIT 500').all() as Row[];
      const csv = ['number,name,status,city,country']
        .concat(rows.map((r) => [r['number'], r['name'], r['status'], r['city'], r['country']].join(',')))
        .join('\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="customers-${em[1]}.csv"`,
      });
      return void res.end(csv);
    }

    if (path === '/app/orders' && method === 'GET') return html(res, ordersPage(ctx));
    if (path === '/app/reports/audit') return html(res, auditPage(ctx));
    if (path === '/app/reports/revenue') return html(res, revenuePage(ctx));
    // Served as its own document so the vehicle page has a genuine nested
    // browsing context rather than a srcdoc approximation.
    if (path === '/legacy/valuation') {
      return html(res, legacyValuationPage(url.searchParams.get('vin') ?? ''));
    }

    // ---- workshop + parts -------------------------------------------------
    if (path === '/app/workshop' && method === 'GET') return html(res, workshopPage(ctx));

    if (path === '/app/workshop/move' && method === 'POST') {
      const form = await readForm(req);
      const apptId = Number(form['appointment_id']);
      const bayId = Number(form['bay_id']);
      const day = form['day'] ?? '';
      const slot = Number(form['slot']);
      const via = form['method'] === 'keyboard' ? 'keyboard' : 'drag';

      const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId) as Row | undefined;
      if (!appt) { setFlash('error', 'That appointment no longer exists.'); return redirect(res, '/app/workshop'); }

      const taken = db
        .prepare('SELECT id FROM appointments WHERE bay_id = ? AND day = ? AND slot = ?')
        .get(bayId, day, slot) as Row | undefined;
      if (taken) { setFlash('error', 'That slot is already booked.'); return redirect(res, '/app/workshop'); }

      db.prepare('UPDATE appointments SET bay_id = ?, day = ?, slot = ? WHERE id = ?').run(bayId, day, slot, apptId);
      audit(db, {
        actor,
        action: 'appointment.move',
        entity: 'appointment',
        entityId: apptId,
        // Which route was used is recorded so drag and keyboard can be scored
        // separately — an agent that can only do one of them is still useful,
        // but you want to know which.
        detail: `bay ${String(appt['bay_id'])}/${String(appt['day'])}/${String(appt['slot'])} -> bay ${bayId}/${day}/${slot} via ${via}`,
      });
      setFlash('ok', `Appointment moved via ${via}.`);
      return redirect(res, '/app/workshop');
    }

    if (path === '/app/parts' && method === 'GET') {
      const cat = Number(url.searchParams.get('category'));
      const part = Number(url.searchParams.get('part'));
      return html(res, partsPage(ctx, Number.isFinite(cat) && cat ? cat : undefined,
                                      Number.isFinite(part) && part ? part : undefined));
    }

    let pm = /^\/app\/parts\/(\d+)\/restock$/.exec(path);
    if (pm && method === 'POST') {
      const id = Number(pm[1]);
      const form = await readForm(req);
      const qty = Number(form['qty']);
      const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(id) as Row | undefined;
      if (!part || !Number.isFinite(qty) || qty < 1) {
        setFlash('error', 'Enter a quantity of at least 1.');
        return redirect(res, req.headers.referer ?? '/app/parts');
      }
      db.prepare('UPDATE parts SET stock = stock + ? WHERE id = ?').run(qty, id);
      audit(db, { actor, action: 'part.restock', entity: 'part', entityId: id,
                  detail: `${String(part['sku'])} +${qty}` });
      setFlash('ok', `${String(part['sku'])} restocked by ${qty}.`);
      return redirect(res, `/app/parts?category=${String(part['category_id'])}&part=${id}`);
    }

    // ---- billing ----------------------------------------------------------
    if (path === '/app/invoices' && method === 'GET') return html(res, invoicesPage(ctx));

    let im = /^\/app\/invoices\/(\d+)(?:\/(print|pay))?$/.exec(path);
    if (im) {
      const id = Number(im[1]);
      const sub = im[2];
      if (sub === 'print') return html(res, invoicePrintPage(ctx, id));
      if (sub === 'pay' && method === 'POST') {
        const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Row | undefined;
        if (!inv) return html(res, notFoundPage(ctx), 404);
        const form = await readForm(req);
        const cents = Math.round(Number(form['amount']) * 100);
        const outstanding = Number(inv['total_cents']) - Number(inv['paid_cents']);
        if (!Number.isFinite(cents) || cents <= 0) {
          setFlash('error', 'Enter a payment amount greater than zero.');
          return redirect(res, `/app/invoices/${id}`);
        }
        if (cents > outstanding) {
          // Discoverable only by trying: the ceiling is the outstanding amount.
          setFlash('error', `Payment exceeds the outstanding ${money(outstanding)}.`);
          return redirect(res, `/app/invoices/${id}`);
        }
        const paid = Number(inv['paid_cents']) + cents;
        const status = paid >= Number(inv['total_cents']) ? 'Paid' : 'Part paid';
        db.prepare('UPDATE invoices SET paid_cents = ?, status = ? WHERE id = ?').run(paid, status, id);
        audit(db, { actor, action: 'invoice.pay', entity: 'invoice', entityId: id,
                    detail: `${money(cents)} -> ${status}` });
        setFlash('ok', `Payment of ${money(cents)} recorded. Invoice is ${status}.`);
        return redirect(res, `/app/invoices/${id}`);
      }
      return html(res, invoiceDetailPage(ctx, id));
    }

    // ---- tickets ----------------------------------------------------------
    if (path === '/app/tickets' && method === 'GET') return html(res, ticketsPage(ctx));

    let tm = /^\/app\/tickets\/(\d+)\/field$/.exec(path);
    if (tm && method === 'POST') {
      const id = Number(tm[1]);
      const form = await readForm(req);
      const field = form['field'] ?? '';
      const value = form['value'] ?? '';
      const allowed: Record<string, string[]> = {
        priority: TICKET_PRIORITIES,
        assignee: ASSIGNEES,
        status: TICKET_STATUSES,
      };
      if (!allowed[field] || !allowed[field]!.includes(value)) {
        setFlash('error', 'That value is not allowed for this field.');
        return redirect(res, '/app/tickets');
      }
      const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Row | undefined;
      if (!t) return html(res, notFoundPage(ctx), 404);
      db.prepare(`UPDATE tickets SET ${field} = ? WHERE id = ?`).run(value, id);
      audit(db, { actor, action: 'ticket.update', entity: 'ticket', entityId: id,
                  detail: `${field}: ${String(t[field])} -> ${value}` });
      setFlash('ok', `${String(t['number'])} ${field} set to ${value}.`);
      return redirect(res, req.headers.referer ?? '/app/tickets');
    }

    // ---- dashboard + query builder ----------------------------------------
    if (path === '/app/dashboard') return html(res, dashboardPage(ctx));
    if (path === '/app/reports/query') {
      if (method === 'POST') {
        const submitted = new URLSearchParams(await readBody(req));
        if (submitted.get('run') !== '1') {
          return html(res, filterBuilderPage(ctx), 422);
        }
        // Running a query is recorded. This is POST-only so same-origin direct
        // navigation cannot manufacture a passing audit while bypassing the
        // query builder's dynamically created controls.
        const filters = parseFilters(submitted);
        const match = submitted.get('match') === 'any' ? 'any' : 'all';
        const count = applyFilters(db, filters, match).length;
        audit(db, {
          actor,
          action: 'report.query',
          entity: 'query',
          entityId: String(filters.length),
          detail: JSON.stringify({ method, match, filters, resultCount: count }),
        });
        return html(res, filterBuilderPage(ctx, submitted));
      }
      // Ignore every GET query parameter, including a crafted `run=1` URL.
      // browser_navigate is necessarily a GET in both benchmark arms.
      return html(res, filterBuilderPage(ctx));
    }

    if (path === '/app/appointments') return html(res, placeholderPage(ctx, 'Appointments'));

    return html(res, notFoundPage(ctx), 404);
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`fixture app error: ${String(err)}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    try {
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    } catch (error) {
      server.off('error', onError);
      reject(error);
    }
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Fixture server did not bind to an IPv4 TCP address.');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    address,
    db,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
