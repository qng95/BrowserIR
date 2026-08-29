import { money } from './db.js';
import { esc, layout } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;

/**
 * The landing dashboard.
 *
 * Each tile fetches independently, so the page settles in stages rather than
 * all at once. There is no single moment where "the page is loaded" — some
 * tiles have data while others are still skeletons, which is the normal state
 * of a real dashboard and a poor fit for read-once snapshotting.
 */
export function dashboardPage(ctx: PageCtx): string {
  const tiles = [
    { id: 'open-orders', label: 'Open orders' },
    { id: 'stock', label: 'Vehicles in stock' },
    { id: 'outstanding', label: 'Outstanding invoices' },
    { id: 'tickets', label: 'Unresolved tickets' },
  ];

  const body = `
<h2 style="margin:0 0 12px;font-size:17px">Overview</h2>
<div class="tiles">${tiles
    .map(
      (t) => `<div class="tile" data-tile="${t.id}" data-state="loading" aria-busy="true">
    <div class="tlabel">${esc(t.label)}</div>
    <div class="tvalue"><span class="skeleton"><span class="bar" style="width:70px;height:20px"></span></span></div>
  </div>`,
    )
    .join('')}</div>

<div class="card" style="margin-top:18px">
  <h2>Recent activity</h2>
  <div id="activity" data-state="loading" aria-busy="true">
    <div class="skeleton"><div class="bar"></div><div class="bar" style="width:80%"></div><div class="bar" style="width:60%"></div></div>
  </div>
</div>`;

  const script = `
(function () {
  var remaining = 5;
  function settled() {
    remaining -= 1;
    if (remaining === 0) document.documentElement.setAttribute('data-ready', '1');
  }
  function json(response) {
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  }
  // Each tile is its own request, so they land at different times.
  document.querySelectorAll('[data-tile]').forEach(function (el) {
    fetch('/api/dashboard/' + el.getAttribute('data-tile'))
      .then(json)
      .then(function (d) {
        el.querySelector('.tvalue').textContent = d.value;
        el.setAttribute('data-state', 'ready');
        el.removeAttribute('aria-busy');
      })
      .catch(function () {
        el.querySelector('.tvalue').textContent = 'Unavailable';
        el.setAttribute('data-state', 'error');
        el.removeAttribute('aria-busy');
        el.setAttribute('aria-label', el.querySelector('.tlabel').textContent + ': unavailable');
      })
      .then(settled);
  });
  fetch('/api/dashboard/activity')
    .then(json)
    .then(function (d) {
      var box = document.getElementById('activity');
      box.innerHTML = d.html;
      box.setAttribute('data-state', 'ready');
      box.removeAttribute('aria-busy');
    })
    .catch(function () {
      var box = document.getElementById('activity');
      box.innerHTML = '<p class="empty error" role="alert">Recent activity could not be loaded.</p>';
      box.setAttribute('data-state', 'error');
      box.removeAttribute('aria-busy');
    })
    .then(settled);
})();`;

  return layout(body, {
    title: 'Dashboard',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Dashboard' }],
    script,
  });
}

export function dashboardTile(db: PageCtx['db'], id: string): { value: string } | { html: string } | null {
  const one = (sql: string) => Number((db.prepare(sql).get() as Row).n);
  switch (id) {
    case 'open-orders':
      return { value: String(one("SELECT COUNT(*) AS n FROM orders WHERE status NOT IN ('Delivered','Cancelled')")) };
    case 'stock':
      return { value: String(one("SELECT COUNT(*) AS n FROM vehicles WHERE status = 'In stock'")) };
    case 'outstanding':
      return { value: money(one("SELECT COALESCE(SUM(total_cents - paid_cents),0) AS n FROM invoices WHERE status != 'Paid'")) };
    case 'tickets':
      return { value: String(one("SELECT COUNT(*) AS n FROM tickets WHERE status != 'Resolved'")) };
    case 'activity': {
      const rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 8').all() as Row[];
      return {
        html: rows.length
          ? `<ul class="tl">${rows
              .map(
                (r) =>
                  `<li><time>${esc(String(r['at']).slice(11, 16))}</time>` +
                  `<span>${esc(r['actor'])} — ${esc(r['action'])} ${esc(r['entity'])} #${esc(r['entity_id'])}</span></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted">Nothing recorded yet.</p>',
      };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------ filter builder --

const FIELDS: Array<[string, string, 'text' | 'number' | 'enum']> = [
  ['name', 'Customer name', 'text'],
  ['city', 'City', 'text'],
  ['country', 'Country', 'text'],
  ['status', 'Status', 'enum'],
  ['segment', 'Segment', 'enum'],
  ['credit_limit', 'Credit limit', 'number'],
  ['revenue', 'Revenue', 'number'],
];
const OPS: Record<string, string[]> = {
  text: ['contains', 'equals', 'starts with'],
  number: ['=', '>', '<'],
  enum: ['equals', 'not equals'],
};
const ENUMS: Record<string, string[]> = {
  status: ['Active', 'Prospect', 'On hold', 'Churned'],
  segment: ['Fleet', 'Retail', 'Dealer', 'Key account'],
};

export interface FilterRow {
  field: string;
  op: string;
  value: string;
}

export function parseFilters(params: URLSearchParams): FilterRow[] {
  const fields = params.getAll('f_field');
  const ops = params.getAll('f_op');
  const values = params.getAll('f_value');
  const out: FilterRow[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (!FIELDS.some(([k]) => k === field)) continue;
    out.push({ field, op: ops[i] ?? 'contains', value: values[i] ?? '' });
  }
  return out;
}

export function applyFilters(db: PageCtx['db'], filters: FilterRow[], match: 'all' | 'any'): Row[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  for (const f of filters) {
    const type = FIELDS.find(([k]) => k === f.field)?.[2] ?? 'text';
    if (type === 'number') {
      const n = Number(f.value);
      if (!Number.isFinite(n)) continue;
      clauses.push(`${f.field} ${f.op === '>' ? '>' : f.op === '<' ? '<' : '='} ?`);
      args.push(n);
    } else if (f.op === 'equals') {
      clauses.push(`${f.field} = ?`);
      args.push(f.value);
    } else if (f.op === 'not equals') {
      clauses.push(`${f.field} != ?`);
      args.push(f.value);
    } else if (f.op === 'starts with') {
      clauses.push(`${f.field} LIKE ?`);
      args.push(`${f.value}%`);
    } else {
      clauses.push(`${f.field} LIKE ?`);
      args.push(`%${f.value}%`);
    }
  }
  if (clauses.length === 0) return [];
  const sql = `SELECT * FROM customers WHERE ${clauses.join(match === 'all' ? ' AND ' : ' OR ')} ORDER BY name LIMIT 100`;
  return db.prepare(sql).all(...(args as never[])) as Row[];
}

/**
 * A query builder with dynamically added condition rows.
 *
 * Rows are created and destroyed client-side, so the number of inputs on the
 * page is a function of what the user has done rather than of what the server
 * sent. An agent that needs three conditions has to add two rows before the
 * fields it wants to fill in even exist.
 */
export function filterBuilderPage(ctx: PageCtx, submitted?: URLSearchParams): string {
  // Query parameters on a GET are deliberately ignored. The benchmark allows
  // same-origin navigation, so executing from the URL would let an agent skip
  // the dynamic controls entirely. Only the rendered POST form can supply a
  // submitted query.
  const ran = submitted?.get('run') === '1';
  const filters = ran ? parseFilters(submitted) : [];
  const match = ran && submitted.get('match') === 'any' ? 'any' : 'all';
  const results = ran ? applyFilters(ctx.db, filters, match) : [];

  const rowMarkup = (f: FilterRow | null, i: number) => {
    const field = f?.field ?? 'name';
    const type = FIELDS.find(([k]) => k === field)?.[2] ?? 'text';
    const valueLabel = `Value ${i + 1}`;
    const valueMarkup = type === 'enum'
      ? `<select name="f_value" aria-label="${valueLabel}">
    ${(ENUMS[field] ?? []).map((value) => `<option value="${esc(value)}"${value === f?.value ? ' selected' : ''}>${esc(value)}</option>`).join('')}
  </select>`
      : `<input name="f_value" type="${type === 'number' ? 'number' : 'text'}" value="${esc(f?.value ?? '')}" aria-label="${valueLabel}" placeholder="Value">`;
    return `<div class="frow" data-frow>
  <select name="f_field" aria-label="Field ${i + 1}">
    ${FIELDS.map(([k, l]) => `<option value="${k}"${k === field ? ' selected' : ''}>${l}</option>`).join('')}
  </select>
  <select name="f_op" aria-label="Operator ${i + 1}">
    ${(OPS[type] ?? OPS['text']!).map((o) => `<option value="${o}"${o === f?.op ? ' selected' : ''}>${o}</option>`).join('')}
  </select>
  ${valueMarkup}
  <button type="button" class="btn" data-removerow aria-label="Remove condition ${i + 1}">Remove</button>
</div>`;
  };

  const body = `
<div class="card">
  <h2>Customer query</h2>
  <form method="post" action="/app/reports/query">
    <div class="toolbar">
      <label for="match" class="muted">Match</label>
      <select id="match" name="match">
        <option value="all"${match === 'all' ? ' selected' : ''}>all conditions</option>
        <option value="any"${match === 'any' ? ' selected' : ''}>any condition</option>
      </select>
    </div>
    <div id="frows">${(filters.length ? filters : [null]).map((f, i) => rowMarkup(f, i)).join('')}</div>
    <div class="toolbar">
      <button type="button" class="btn" id="addrow">Add condition</button>
      <button class="btn primary" type="submit" name="run" value="1">Run query</button>
    </div>
  </form>
</div>

${
  ran
    ? `<div class="card">
  <h2>Results</h2>
  <p class="muted" role="status" id="resultcount">${results.length} customer(s) matched.</p>
  ${
    results.length === 0
      ? '<p class="empty">Nothing matched those conditions.</p>'
      : `<table><thead><tr><th>Number</th><th>Name</th><th>Status</th><th>City</th><th>Credit limit</th></tr></thead>
      <tbody>${results
        .map(
          (r) =>
            `<tr><td>${esc(r['number'])}</td><td><a href="/app/customers/${esc(r['id'])}">${esc(r['name'])}</a></td>` +
            `<td>${esc(r['status'])}</td><td>${esc(r['city'])}</td>` +
            `<td class="num">${money(Number(r['credit_limit']) * 100)}</td></tr>`,
        )
        .join('')}</tbody></table>`
  }
</div>`
    : ''
}`;

  const script = `
(function () {
  var OPS = ${JSON.stringify(OPS)};
  var ENUMS = ${JSON.stringify(ENUMS)};
  var TYPES = ${JSON.stringify(Object.fromEntries(FIELDS.map(([k, , t]) => [k, t])))};
  var rows = document.getElementById('frows');

  function syncRow(row, preserveValue) {
    var field = row.querySelector('[name=f_field]').value;
    var type = TYPES[field] || 'text';
    var op = row.querySelector('[name=f_op]');
    var priorOp = op.value;
    op.innerHTML = OPS[type].map(function (choice) {
      return '<option value="' + choice + '">' + choice + '</option>';
    }).join('');
    if (OPS[type].indexOf(priorOp) >= 0) op.value = priorOp;

    var oldValue = row.querySelector('[name=f_value]');
    var priorValue = preserveValue ? oldValue.value : '';
    var label = oldValue.getAttribute('aria-label');
    var nextValue;
    if (ENUMS[field]) {
      nextValue = document.createElement('select');
      nextValue.innerHTML = ENUMS[field].map(function (choice) {
        return '<option value="' + choice + '">' + choice + '</option>';
      }).join('');
      if (ENUMS[field].indexOf(priorValue) >= 0) nextValue.value = priorValue;
    } else {
      nextValue = document.createElement('input');
      nextValue.type = type === 'number' ? 'number' : 'text';
      nextValue.placeholder = 'Value';
      nextValue.value = type === 'number' && priorValue && !Number.isFinite(Number(priorValue))
        ? ''
        : priorValue;
    }
    nextValue.name = 'f_value';
    nextValue.setAttribute('aria-label', label);
    oldValue.replaceWith(nextValue);
  }

  function template() {
    var first = rows.querySelector('[data-frow]');
    var clone = first.cloneNode(true);
    clone.querySelector('[name=f_field]').value = 'name';
    syncRow(clone, false);
    return clone;
  }

  document.getElementById('addrow').addEventListener('click', function () {
    // The inputs for a third condition simply do not exist until this runs.
    rows.appendChild(template());
    relabel();
  });

  rows.addEventListener('click', function (ev) {
    if (!ev.target.closest('[data-removerow]')) return;
    if (rows.querySelectorAll('[data-frow]').length === 1) return;
    ev.target.closest('[data-frow]').remove();
    relabel();
  });

  // Operator choices depend on the field, so changing the field rewrites the
  // adjacent control.
  rows.addEventListener('change', function (ev) {
    if (ev.target.name !== 'f_field') return;
    syncRow(ev.target.closest('[data-frow]'), true);
  });

  function relabel() {
    rows.querySelectorAll('[data-frow]').forEach(function (r, i) {
      r.querySelector('[name=f_field]').setAttribute('aria-label', 'Field ' + (i + 1));
      r.querySelector('[name=f_op]').setAttribute('aria-label', 'Operator ' + (i + 1));
      r.querySelector('[name=f_value]').setAttribute('aria-label', 'Value ' + (i + 1));
      r.querySelector('[data-removerow]').setAttribute('aria-label', 'Remove condition ' + (i + 1));
    });
  }
})();`;

  return layout(body, {
    title: 'Query',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Reports', href: '/app/reports/revenue' }, { label: 'Query' }],
    script,
  });
}
