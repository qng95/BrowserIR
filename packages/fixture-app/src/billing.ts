import { money } from './db.js';
import { esc, layout, statusPill } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;
const PAGE_SIZE = 25;

export const INVOICE_STATUSES = ['Open', 'Part paid', 'Paid', 'Overdue'];
export const TICKET_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
export const TICKET_STATUSES = ['New', 'In progress', 'Waiting for parts', 'Resolved'];
export const ASSIGNEES = ['S. Weber', 'A. Klein', 'M. Roth', 'Unassigned'];

// ----------------------------------------------------------------- invoices --

export function invoicesPage(ctx: PageCtx): string {
  const p = ctx.url.searchParams;
  const status = p.get('status') ?? '';
  const page = Math.max(1, Number(p.get('page') ?? '1') || 1);

  const where = status ? 'WHERE i.status = ?' : '';
  const args: unknown[] = status ? [status] : [];
  const total = Number(
    (ctx.db.prepare(`SELECT COUNT(*) AS n FROM invoices i ${where}`).get(...(args as never[])) as Row).n,
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (Math.min(page, pages) - 1) * PAGE_SIZE;

  const rows = ctx.db
    .prepare(
      `SELECT i.*, c.name AS customer FROM invoices i JOIN customers c ON c.id = i.customer_id
       ${where} ORDER BY i.issued_on DESC, i.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...([...args, PAGE_SIZE, offset] as never[])) as Row[];

  const outstanding = Number(
    (ctx.db.prepare("SELECT COALESCE(SUM(total_cents - paid_cents),0) AS n FROM invoices WHERE status != 'Paid'").get() as Row).n,
  );

  const body = `
<div class="toolbar">
  <form method="get" action="/app/invoices" class="toolbar" style="margin:0">
    <label for="status" class="muted">Status</label>
    <select id="status" name="status">
      <option value="">All</option>
      ${INVOICE_STATUSES.map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>
    <button class="btn" type="submit">Apply</button>
    ${status ? `<a class="btn" href="/app/invoices">Clear</a>` : ''}
  </form>
</div>
<p class="muted" role="status">${total.toLocaleString('en-US')} invoices ·
   outstanding <strong>${money(outstanding)}</strong> · page ${Math.min(page, pages)} of ${pages}</p>

<table>
  <thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Total</th><th>Paid</th><th>Status</th><th></th></tr></thead>
  <tbody>${
    rows.length === 0
      ? `<tr><td colspan="8" class="empty">No invoices match that filter.</td></tr>`
      : rows
          .map(
            (r) => `<tr data-invoice="${esc(r['id'])}">
    <td><a href="/app/invoices/${esc(r['id'])}">${esc(r['number'])}</a></td>
    <td>${esc(r['customer'])}</td>
    <td>${esc(r['issued_on'])}</td>
    <td>${esc(r['due_on'])}</td>
    <td class="num">${money(Number(r['total_cents']))}</td>
    <td class="num">${money(Number(r['paid_cents']))}</td>
    <td>${statusPill(String(r['status']))}</td>
    <td><a href="/app/invoices/${esc(r['id'])}/print" target="_blank" rel="noopener">Print</a></td>
  </tr>`,
          )
          .join('')
  }</tbody>
</table>
<div class="pager">
  ${page > 1 ? `<a class="btn" href="/app/invoices?status=${esc(status)}&page=${page - 1}">Previous</a>` : `<span class="btn" aria-disabled="true">Previous</span>`}
  ${page < pages ? `<a class="btn" href="/app/invoices?status=${esc(status)}&page=${page + 1}">Next</a>` : `<span class="btn" aria-disabled="true">Next</span>`}
</div>`;

  return layout(body, {
    title: 'Invoices',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Billing', href: '/app/invoices' }, { label: 'Invoices' }],
  });
}

export function invoiceDetailPage(ctx: PageCtx, id: number): string {
  const inv = ctx.db
    .prepare('SELECT i.*, c.name AS customer, c.number AS custno FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?')
    .get(id) as Row | undefined;
  if (!inv) {
    return layout('<div class="card"><h2>Not found</h2></div>', { title: 'Not found', path: ctx.path, user: ctx.user });
  }
  const outstanding = Number(inv['total_cents']) - Number(inv['paid_cents']);

  const body = `
<div class="card">
  <h2>${esc(inv['number'])} ${statusPill(String(inv['status']))}</h2>
  <div class="field"><label>Customer</label><div>${esc(inv['custno'])} — ${esc(inv['customer'])}</div></div>
  <div class="field"><label>Issued</label><div>${esc(inv['issued_on'])}</div></div>
  <div class="field"><label>Due</label><div>${esc(inv['due_on'])}</div></div>
  <div class="field"><label>Total</label><div>${money(Number(inv['total_cents']))}</div></div>
  <div class="field"><label>Paid</label><div>${money(Number(inv['paid_cents']))}</div></div>
  <div class="field"><label>Outstanding</label><div><strong>${money(outstanding)}</strong></div></div>
  <div class="toolbar">
    <!-- Opens in a new tab. An agent has to notice the tab and switch to it. -->
    <a class="btn" href="/app/invoices/${id}/print" target="_blank" rel="noopener" id="printlink">Open print view</a>
  </div>
</div>

${
  outstanding > 0
    ? `<div class="card">
  <h2>Record payment</h2>
  <form method="post" action="/app/invoices/${id}/pay">
    <div class="field">
      <label for="amount">Amount (€)</label>
      <div><input id="amount" name="amount" type="number" step="1" value="${Math.round(outstanding / 100)}">
        <div class="muted" style="font-size:12px">Outstanding is ${money(outstanding)}. Overpayment is rejected.</div></div>
    </div>
    <button class="btn primary" type="submit">Record payment</button>
  </form>
</div>`
    : `<div class="card"><p class="muted">This invoice is settled.</p></div>`
}`;

  return layout(body, {
    title: String(inv['number']),
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [
      { label: 'Billing', href: '/app/invoices' },
      { label: 'Invoices', href: '/app/invoices' },
      { label: String(inv['number']) },
    ],
  });
}

/**
 * A print-only document, served as its own page with no application chrome.
 *
 * Real billing screens produce one of these and open it in a new tab. It is a
 * separate browsing context with a different layout, so an agent that assumes
 * the page it is on is the page it was reading gets it wrong.
 */
export function invoicePrintPage(ctx: PageCtx, id: number): string {
  const inv = ctx.db
    .prepare(
      `SELECT i.*, c.name AS customer, c.street, c.postal_code, c.city, c.country, c.vat_id
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`,
    )
    .get(id) as Row | undefined;
  if (!inv) return '<!doctype html><title>Not found</title><p>No such invoice.</p>';

  const lines = ctx.db
    .prepare('SELECT * FROM order_lines WHERE order_id = ?')
    .all(Number(inv['order_id'] ?? 0)) as Row[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(inv['number'])}</title>
<style>
body{font:13px -apple-system,system-ui,sans-serif;color:#1f2328;margin:0;padding:34px;background:#fff}
h1{font-size:19px;margin:0 0 4px}
.meta{display:flex;justify-content:space-between;gap:30px;margin:22px 0}
.meta div{font-size:12.5px;line-height:1.6}
table{border-collapse:collapse;width:100%;margin-top:18px}
th{text-align:left;border-bottom:2px solid #1f2328;padding:7px 6px;font-size:12px}
td{padding:7px 6px;border-bottom:1px solid #e3e6ea}
.num{text-align:right;font-variant-numeric:tabular-nums}
tfoot td{font-weight:700;border-top:2px solid #1f2328;border-bottom:0}
.actions{margin-top:26px}
button{padding:7px 15px;border:1px solid #ccd2d8;border-radius:5px;background:#fff;cursor:pointer;font:inherit}
@media print{.actions{display:none}body{padding:0}}
</style></head>
<body>
<h1>Invoice ${esc(inv['number'])}</h1>
<div class="muted">Autohaus DMS GmbH · Hauptstrasse 1 · 80331 München</div>
<div class="meta">
  <div><strong>Bill to</strong><br>${esc(inv['customer'])}<br>${esc(inv['street'] ?? '')}<br>
    ${esc(inv['postal_code'] ?? '')} ${esc(inv['city'])}<br>${esc(inv['country'])}<br>
    VAT ${esc(inv['vat_id'] ?? '—')}</div>
  <div><strong>Issued</strong> ${esc(inv['issued_on'])}<br><strong>Due</strong> ${esc(inv['due_on'])}<br>
    <strong>Status</strong> ${esc(inv['status'])}</div>
</div>
<table>
  <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Amount</th></tr></thead>
  <tbody>${
    lines.length
      ? lines
          .map(
            (l) =>
              `<tr><td>${esc(l['description'])}</td><td class="num">${esc(l['qty'])}</td>` +
              `<td class="num">${money(Number(l['unit_cents']))}</td>` +
              `<td class="num">${money(Number(l['unit_cents']) * Number(l['qty']))}</td></tr>`,
          )
          .join('')
      : `<tr><td>Vehicle supply per order</td><td class="num">1</td>
         <td class="num">${money(Number(inv['total_cents']))}</td>
         <td class="num">${money(Number(inv['total_cents']))}</td></tr>`
  }</tbody>
  <tfoot><tr><td colspan="3">Total</td><td class="num" id="printtotal">${money(Number(inv['total_cents']))}</td></tr></tfoot>
</table>
<div class="actions"><button type="button" id="doprint" onclick="window.print()">Print</button></div>
</body></html>`;
}

// ------------------------------------------------------------------ tickets --

/**
 * Service tickets with inline editing.
 *
 * A single click selects the row; a *double* click on the priority or assignee
 * cell turns it into a control. That is the capability overload a boolean
 * `isInteractive` flag cannot represent — the same cell has two different
 * behaviours, and the editor does not exist in the DOM until the second click.
 */
export function ticketsPage(ctx: PageCtx): string {
  const status = ctx.url.searchParams.get('status') ?? '';
  const where = status ? 'WHERE t.status = ?' : '';
  const args: unknown[] = status ? [status] : [];
  const rows = ctx.db
    .prepare(
      `SELECT t.*, c.name AS customer FROM tickets t JOIN customers c ON c.id = t.customer_id
       ${where} ORDER BY t.id LIMIT 60`,
    )
    .all(...(args as never[])) as Row[];

  const body = `
<div class="toolbar">
  <form method="get" action="/app/tickets" class="toolbar" style="margin:0">
    <label for="status" class="muted">Status</label>
    <select id="status" name="status">
      <option value="">All</option>
      ${TICKET_STATUSES.map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>
    <button class="btn" type="submit">Apply</button>
    ${status ? `<a class="btn" href="/app/tickets">Clear</a>` : ''}
  </form>
</div>
<p class="muted">Double-click a priority or assignee cell to edit it.</p>

<table id="tickets">
  <thead><tr><th>Ticket</th><th>Customer</th><th>Subject</th><th>Priority</th><th>Assignee</th><th>Status</th><th>Opened</th></tr></thead>
  <tbody>${rows
    .map(
      (t) => `<tr data-ticket="${esc(t['id'])}">
    <td>${esc(t['number'])}</td>
    <td>${esc(t['customer'])}</td>
    <td>${esc(t['subject'])}</td>
    <td class="editable" data-field="priority" data-value="${esc(t['priority'])}" tabindex="0">${esc(t['priority'])}</td>
    <td class="editable" data-field="assignee" data-value="${esc(t['assignee'])}" tabindex="0">${esc(t['assignee'])}</td>
    <td>${statusPill(String(t['status']))}</td>
    <td>${esc(t['opened_on'])}</td>
  </tr>`,
    )
    .join('')}</tbody>
</table>`;

  const script = `
(function () {
  var OPTIONS = {
    priority: ${JSON.stringify(TICKET_PRIORITIES)},
    assignee: ${JSON.stringify(ASSIGNEES)}
  };
  var table = document.getElementById('tickets');

  // Single click selects. Only a double click opens the editor.
  table.addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-ticket]');
    if (!tr) return;
    table.querySelectorAll('tr[aria-selected]').forEach(function (r) { r.removeAttribute('aria-selected'); });
    tr.setAttribute('aria-selected', 'true');
  });

  table.addEventListener('dblclick', function (ev) {
    var cell = ev.target.closest('td.editable');
    if (!cell || cell.querySelector('select')) return;
    var field = cell.getAttribute('data-field');
    var current = cell.getAttribute('data-value');
    var id = cell.closest('tr').getAttribute('data-ticket');

    var sel = document.createElement('select');
    sel.setAttribute('aria-label', field);
    sel.innerHTML = OPTIONS[field].map(function (o) {
      return '<option value="' + o + '"' + (o === current ? ' selected' : '') + '>' + o + '</option>';
    }).join('');
    cell.textContent = '';
    cell.appendChild(sel);
    sel.focus();

    function commit() {
      if (sel.value === current) { cell.textContent = current; return; }
      var f = document.createElement('form');
      f.method = 'post';
      f.action = '/app/tickets/' + id + '/field';
      f.innerHTML = '<input name="field" value="' + field + '">' +
                    '<input name="value" value="' + sel.value + '">';
      document.body.appendChild(f);
      f.submit();
    }
    sel.addEventListener('change', commit);
    sel.addEventListener('blur', function () { if (sel.isConnected) cell.textContent = sel.value; });
  });
})();`;

  return layout(body, {
    title: 'Tickets',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Service', href: '/app/workshop' }, { label: 'Tickets' }],
    script,
  });
}
