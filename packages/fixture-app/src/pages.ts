import type { DatabaseSync } from 'node:sqlite';

import { money } from './db.js';
import { esc, layout, statusPill, type LayoutOptions } from './views.js';

type Row = Record<string, unknown>;

export interface PageCtx {
  db: DatabaseSync;
  path: string;
  url: URL;
  user?: { username: string; display_name: string } | undefined;
  flash?: { kind: 'ok' | 'error'; text: string } | undefined;
}

const PAGE_SIZE = 25;
const SORTABLE = ['number', 'name', 'status', 'city', 'country', 'owner', 'credit_limit', 'revenue', 'last_contact'];

function chrome(ctx: PageCtx, title: string, body: string, extra: Partial<LayoutOptions> = {}): string {
  return layout(body, {
    title,
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    ...extra,
  });
}

// ---------------------------------------------------------------- login ----

export function loginPage(ctx: PageCtx, error?: string): string {
  const next = ctx.url.searchParams.get('next') ?? '/app/customers';
  return chrome(
    ctx,
    'Sign in',
    `<div class="login">
  <div class="card">
    <h2>Sign in</h2>
    ${error ? `<div class="flash error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/app/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <div class="field" style="grid-template-columns:1fr">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required>
      </div>
      <div class="field" style="grid-template-columns:1fr">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="hint">Fixture credentials: <code>test / test</code></p>
    </form>
  </div>
</div>`,
  );
}

// ------------------------------------------------------------ customers ----

export function customerListPage(ctx: PageCtx): string {
  const p = ctx.url.searchParams;
  const q = (p.get('q') ?? '').trim();
  const status = p.get('status') ?? '';
  const sort = SORTABLE.includes(p.get('sort') ?? '') ? p.get('sort')! : 'number';
  const dir = p.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(p.get('page') ?? '1') || 1);

  const where: string[] = [];
  const args: unknown[] = [];
  if (q) {
    where.push('(name LIKE ? OR number LIKE ? OR city LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(
    (ctx.db.prepare(`SELECT COUNT(*) AS n FROM customers ${whereSql}`).get(...(args as never[])) as Row).n,
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (Math.min(page, pages) - 1) * PAGE_SIZE;

  const rows = ctx.db
    .prepare(`SELECT * FROM customers ${whereSql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
    .all(...([...args, PAGE_SIZE, offset] as never[])) as Row[];

  const link = (over: Record<string, string>) => {
    const s = new URLSearchParams(p);
    for (const [k, v] of Object.entries(over)) v ? s.set(k, v) : s.delete(k);
    return `/app/customers?${s.toString()}`;
  };
  const th = (key: string, label: string) => {
    const active = sort === key;
    const nextDir = active && dir === 'asc' ? 'desc' : 'asc';
    const arrow = active ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th${active ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
      <a href="${link({ sort: key, dir: nextDir, page: '1' })}">${esc(label)}${arrow}</a></th>`;
  };

  const body = `
<div class="toolbar">
  <form method="get" action="/app/customers" class="toolbar" style="margin:0">
    <input type="hidden" name="sort" value="${esc(sort)}"><input type="hidden" name="dir" value="${esc(dir)}">
    <label for="q" class="muted">Search</label>
    <input id="q" name="q" type="text" value="${esc(q)}" placeholder="Name, number or city">
    <label for="status" class="muted">Status</label>
    <select id="status" name="status">
      <option value="">All</option>
      ${['Active', 'Prospect', 'On hold', 'Churned']
        .map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`)
        .join('')}
    </select>
    <button class="btn" type="submit">Apply</button>
    ${q || status ? `<a class="btn" href="/app/customers">Clear</a>` : ''}
  </form>
  <div style="flex:1"></div>
  <a class="btn primary" href="/app/customers/new">New customer</a>
</div>

<p class="muted" role="status">${total.toLocaleString('en-US')} customers · page ${Math.min(page, pages)} of ${pages}</p>

<table>
  <thead><tr>
    ${th('number', 'Number')}${th('name', 'Customer')}${th('status', 'Status')}${th('city', 'City')}
    ${th('country', 'Country')}${th('owner', 'Owner')}${th('credit_limit', 'Credit limit')}${th('last_contact', 'Last contact')}
    <th></th>
  </tr></thead>
  <tbody>
    ${
      rows.length === 0
        ? `<tr><td colspan="9" class="empty">No customers match that filter.</td></tr>`
        : rows
            .map(
              (r) => `<tr>
      <td>${esc(r['number'])}</td>
      <td><a href="/app/customers/${esc(r['id'])}">${esc(r['name'])}</a></td>
      <td>${statusPill(String(r['status']))}</td>
      <td>${esc(r['city'])}</td>
      <td>${esc(r['country'])}</td>
      <td>${esc(r['owner'])}</td>
      <td class="num">${money(Number(r['credit_limit']) * 100)}</td>
      <td>${esc(r['last_contact'])}</td>
      <td><a href="/app/customers/${esc(r['id'])}/edit">Edit</a></td>
    </tr>`,
            )
            .join('')
    }
  </tbody>
</table>

<div class="pager">
  ${page > 1 ? `<a class="btn" href="${link({ page: String(page - 1) })}">Previous</a>` : `<span class="btn" aria-disabled="true">Previous</span>`}
  ${page < pages ? `<a class="btn" href="${link({ page: String(page + 1) })}">Next</a>` : `<span class="btn" aria-disabled="true">Next</span>`}
  <span class="muted">Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}</span>
</div>`;

  return chrome(ctx, 'Customers', body, {
    breadcrumbs: [{ label: 'Sales', href: '/app/customers' }, { label: 'Customers' }],
  });
}

// --------------------------------------------------------- customer view ---

export function customerDetailPage(ctx: PageCtx, id: number, tab: string): string {
  const c = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Row | undefined;
  if (!c) return notFoundPage(ctx);

  const tabs = ['overview', 'contacts', 'orders'];
  const tabBar = `<div class="tabs" role="tablist">${tabs
    .map(
      (t) =>
        `<a role="tab" href="/app/customers/${id}${t === 'overview' ? '' : '/' + t}"${
          t === tab ? ' aria-current="page" aria-selected="true"' : ' aria-selected="false"'
        }>${t[0]!.toUpperCase() + t.slice(1)}</a>`,
    )
    .join('')}</div>`;

  let panel: string;
  let script: string | undefined;

  if (tab === 'overview') {
    panel = `<div class="card">
  <h2>${esc(c['name'])}</h2>
  <div class="field"><label>Number</label><div>${esc(c['number'])}</div></div>
  <div class="field"><label>Status</label><div>${statusPill(String(c['status']))}</div></div>
  <div class="field"><label>Owner</label><div>${esc(c['owner'])}</div></div>
  <div class="field"><label>Segment</label><div>${esc(c['segment'])}</div></div>
  <div class="field"><label>Address</label><div>${esc(c['street'])}, ${esc(c['postal_code'])} ${esc(c['city'])}, ${esc(c['country'])}</div></div>
  <div class="field"><label>VAT ID</label><div>${esc(c['vat_id'])}</div></div>
  <div class="field"><label>Credit limit</label><div>${money(Number(c['credit_limit']) * 100)}</div></div>
  <div class="field"><label>Revenue</label><div>${money(Number(c['revenue']) * 100)}</div></div>
  <div class="field"><label>Last contact</label><div>${esc(c['last_contact'])}</div></div>
  <a class="btn primary" href="/app/customers/${id}/edit">Edit customer</a>
</div>`;
  } else {
    // Lazily loaded over the API. The document arrives with a skeleton; the
    // real rows land only after a round trip, so a reader that snapshots
    // immediately sees placeholders — which is the point.
    panel = `<div class="card">
  <h2>${tab === 'contacts' ? 'Contacts' : 'Orders'} <span class="spinner" data-loading aria-label="Loading"></span></h2>
  <div id="panel" data-state="loading" aria-busy="true">
    <div class="skeleton" aria-hidden="true">
      <div class="bar" style="width:70%"></div><div class="bar" style="width:90%"></div>
      <div class="bar" style="width:55%"></div><div class="bar" style="width:80%"></div>
    </div>
  </div>
</div>`;
    script = `
(function () {
  var controller = new AbortController();
  var el = document.getElementById('panel');
  function finish(state) {
    el.setAttribute('data-state', state);
    el.removeAttribute('aria-busy');
    var spinner = document.querySelector('[data-loading]');
    if (spinner) spinner.remove();
    document.documentElement.setAttribute('data-ready', '1');
  }
  addEventListener('pagehide', function () { controller.abort(); }, { once: true });
  fetch('/api/customers/${id}/${tab}' + location.search, { signal: controller.signal })
    .then(function (response) {
      if (!response.ok) throw new Error('Request failed');
      return response.json();
    })
    .then(function (data) {
      if (controller.signal.aborted) return;
      el.innerHTML = data.html;
      finish('ready');
    })
    .catch(function (error) {
      if (error.name === 'AbortError') return;
      el.innerHTML = '<p class="empty error" role="alert">This panel could not be loaded. Try again.</p>';
      finish('error');
    });
})();`;
  }

  return chrome(ctx, String(c['name']), tabBar + panel, {
    breadcrumbs: [
      { label: 'Sales', href: '/app/customers' },
      { label: 'Customers', href: '/app/customers' },
      { label: String(c['name']) },
    ],
    ...(script ? { script } : {}),
  });
}

// --------------------------------------------------------- customer edit ---

export interface FormState {
  values: Record<string, string>;
  errors: Record<string, string>;
}

export function customerFormPage(ctx: PageCtx, mode: 'new' | 'edit', id: number | null, state: FormState): string {
  const action = mode === 'new' ? '/app/customers/new' : `/app/customers/${id}/edit`;
  const v = (k: string) => esc(state.values[k] ?? '');
  const err = (k: string) =>
    state.errors[k] ? `<div class="err" id="err-${k}">${esc(state.errors[k])}</div>` : '';
  const invalid = (k: string) => (state.errors[k] ? ` aria-invalid="true" aria-describedby="err-${k}"` : '');

  const field = (k: string, label: string, type = 'text') => `
<div class="field">
  <label for="${k}">${esc(label)}</label>
  <div><input id="${k}" name="${k}" type="${type}" value="${v(k)}"${invalid(k)}>${err(k)}</div>
</div>`;

  const body = `
<div class="card">
  <h2>${mode === 'new' ? 'New customer' : 'Edit customer'}</h2>
  ${
    Object.keys(state.errors).length
      ? `<div class="flash error" role="alert">${Object.keys(state.errors).length} field(s) need attention.</div>`
      : ''
  }
  <form method="post" action="${action}" novalidate>
    ${field('name', 'Customer name')}
    ${field('city', 'City')}
    ${field('country', 'Country')}
    <div class="field">
      <label for="status">Status</label>
      <div><select id="status" name="status">
        ${['Active', 'Prospect', 'On hold', 'Churned']
          .map((s) => `<option value="${s}"${state.values['status'] === s ? ' selected' : ''}>${s}</option>`)
          .join('')}
      </select></div>
    </div>
    ${field('credit_limit', 'Credit limit (€)', 'number')}
    ${field('vat_id', 'VAT ID')}
    <div class="toolbar">
      <button class="btn primary" type="submit">${mode === 'new' ? 'Create customer' : 'Save changes'}</button>
      <a class="btn" href="${mode === 'new' ? '/app/customers' : `/app/customers/${id}`}">Cancel</a>
    </div>
  </form>
</div>`;

  return chrome(ctx, mode === 'new' ? 'New customer' : 'Edit customer', body, {
    breadcrumbs: [
      { label: 'Sales', href: '/app/customers' },
      { label: 'Customers', href: '/app/customers' },
      { label: mode === 'new' ? 'New' : 'Edit' },
    ],
  });
}

/**
 * Server-side validation.
 *
 * Deliberately stricter than the client: there is no client-side validation at
 * all, so the only way to discover a rule is to submit and read the rendered
 * error. That is a real agent skill — act, observe rejection, correct, retry —
 * and it cannot be exercised by any static page.
 */
export function validateCustomer(values: Record<string, string>, db: DatabaseSync, excludeId?: number): Record<string, string> {
  const e: Record<string, string> = {};
  const name = (values['name'] ?? '').trim();
  if (!name) e['name'] = 'Customer name is required.';
  else if (name.length < 3) e['name'] = 'Customer name must be at least 3 characters.';
  else {
    // Historical imports can already contain duplicate names. Editing another
    // field on one such record must remain possible; uniqueness applies when a
    // create or edit introduces a different name.
    const unchanged =
      excludeId === undefined
        ? undefined
        : (db
            .prepare('SELECT id FROM customers WHERE id = ? AND lower(name) = lower(?)')
            .get(excludeId, name) as Row | undefined);
    if (unchanged === undefined) {
      const clash = db
        .prepare('SELECT id FROM customers WHERE lower(name) = lower(?) AND id IS NOT ?')
        .get(name, excludeId ?? null) as Row | undefined;
      if (clash) e['name'] = 'A customer with this name already exists.';
    }
  }

  if (!(values['city'] ?? '').trim()) e['city'] = 'City is required.';
  if (!(values['country'] ?? '').trim()) e['country'] = 'Country is required.';

  const limit = Number(values['credit_limit']);
  if (!values['credit_limit']) e['credit_limit'] = 'Credit limit is required.';
  else if (!Number.isFinite(limit) || limit < 0) e['credit_limit'] = 'Credit limit must be a positive number.';
  else if (limit > 250000) e['credit_limit'] = 'Credit limit above 250.000 € needs board approval.';

  const vat = (values['vat_id'] ?? '').trim();
  if (vat && !/^[A-Z]{2}\d{9}$/.test(vat)) e['vat_id'] = 'VAT ID must be two letters followed by 9 digits.';

  return e;
}

// -------------------------------------------------------------- other -----

export function auditPage(ctx: PageCtx): string {
  const rows = ctx.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() as Row[];
  const body = `
<div class="card">
  <h2>Audit log</h2>
  <p class="muted">Every mutation the app performs is recorded here. Task verification reads it.</p>
  <table>
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
    <tbody>${
      rows.length === 0
        ? `<tr><td colspan="5" class="empty">Nothing recorded yet.</td></tr>`
        : rows
            .map(
              (r) =>
                `<tr><td>${esc(r['at'])}</td><td>${esc(r['actor'])}</td><td>${esc(r['action'])}</td>` +
                `<td>${esc(r['entity'])} #${esc(r['entity_id'])}</td><td>${esc(r['detail'])}</td></tr>`,
            )
            .join('')
    }</tbody>
  </table>
</div>`;
  return chrome(ctx, 'Audit log', body, {
    breadcrumbs: [{ label: 'Reports', href: '/app/reports/revenue' }, { label: 'Audit log' }],
  });
}

export function revenuePage(ctx: PageCtx): string {
  const rows = ctx.db
    .prepare(
      `SELECT country, COUNT(*) AS customers, SUM(revenue) AS revenue
       FROM customers GROUP BY country ORDER BY revenue DESC`,
    )
    .all() as Row[];
  const body = `
<div class="card">
  <h2>Revenue by country</h2>
  <table>
    <thead><tr><th>Country</th><th>Customers</th><th>Revenue</th></tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr><td>${esc(r['country'])}</td><td class="num">${esc(r['customers'])}</td>` +
          `<td class="num">${money(Number(r['revenue']) * 100)}</td></tr>`,
      )
      .join('')}</tbody>
  </table>
</div>`;
  return chrome(ctx, 'Revenue', body, {
    breadcrumbs: [{ label: 'Reports', href: '/app/reports/revenue' }, { label: 'Revenue' }],
  });
}

export function placeholderPage(ctx: PageCtx, title: string): string {
  return chrome(
    ctx,
    title,
    `<div class="card"><h2>${esc(title)}</h2><p class="muted">Nothing scheduled.</p></div>`,
    { breadcrumbs: [{ label: 'Service', href: '/app/tickets' }, { label: title }] },
  );
}

export function notFoundPage(ctx: PageCtx): string {
  return chrome(ctx, 'Not found', `<div class="card"><h2>Not found</h2><p class="muted">No such page.</p></div>`);
}
