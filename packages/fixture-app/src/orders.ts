import { money } from './db.js';
import { esc, layout, statusPill } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;

const PAGE_SIZE = 25;
export const ORDER_STATUSES = ['Draft', 'Awaiting deposit', 'Confirmed', 'In production', 'Delivered', 'Cancelled'];

/**
 * The orders screen.
 *
 * Carries three patterns no existing agent benchmark exercises:
 *
 *  - **Bulk selection.** The action bar does not exist in the DOM until at
 *    least one row is checked, so a reader that snapshots the idle page never
 *    sees the operations it is supposed to perform.
 *  - **A right-click context menu.** The only route to some actions. It is
 *    created at body level on `contextmenu` and destroyed on the next click,
 *    so it exists for no longer than the interaction itself.
 *  - **Transient toasts.** They auto-dismiss. An agent that reads the page
 *    four seconds after acting has no on-screen evidence of what happened and
 *    must infer the outcome from state instead.
 */
export function ordersPage(ctx: PageCtx): string {
  const p = ctx.url.searchParams;
  const page = Math.max(1, Number(p.get('page') ?? '1') || 1);
  const status = p.get('status') ?? '';

  const where = status ? 'WHERE o.status = ?' : '';
  const args: unknown[] = status ? [status] : [];
  const total = Number(
    (ctx.db.prepare(`SELECT COUNT(*) AS n FROM orders o ${where}`).get(...(args as never[])) as Row).n,
  );
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (Math.min(page, pages) - 1) * PAGE_SIZE;

  const rows = ctx.db
    .prepare(
      `SELECT o.*, c.name AS customer, c.id AS cid FROM orders o
       JOIN customers c ON c.id = o.customer_id ${where}
       ORDER BY o.placed_on DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...([...args, PAGE_SIZE, offset] as never[])) as Row[];

  const link = (over: Record<string, string>) => {
    const s = new URLSearchParams(p);
    for (const [k, v] of Object.entries(over)) v ? s.set(k, v) : s.delete(k);
    return `/app/orders?${s.toString()}`;
  };

  const body = `
<div class="toolbar">
  <form method="get" action="/app/orders" class="toolbar" style="margin:0">
    <label for="status" class="muted">Status</label>
    <select id="status" name="status">
      <option value="">All</option>
      ${ORDER_STATUSES.map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>
    <button class="btn" type="submit">Apply</button>
    ${status ? `<a class="btn" href="/app/orders">Clear</a>` : ''}
  </form>
  <div style="flex:1"></div>
  <a class="btn primary" href="/app/orders/new">New order</a>
</div>

<p class="muted" role="status">${total.toLocaleString('en-US')} orders · page ${Math.min(page, pages)} of ${pages}</p>

<!-- Injected by script only while a selection exists. -->
<div id="bulkbar-host"></div>

<form method="post" action="/app/orders/bulk" id="bulkform">
  <input type="hidden" name="bulk_action" id="bulk_action" value="">
  <input type="hidden" name="operation_scope" value="bulk">
  <table id="ordertable">
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="selall" aria-label="Select all orders on this page"></th>
      <th>Order</th><th>Customer</th><th>Placed</th><th>Vehicle</th><th>Status</th><th>Total</th>
    </tr></thead>
    <tbody>${
      rows.length === 0
        ? `<tr><td colspan="7" class="empty">No orders match that filter.</td></tr>`
        : rows
            .map(
              (r) => `<tr data-order="${esc(r['id'])}" data-number="${esc(r['number'])}" data-status="${esc(r['status'])}"
          tabindex="0" aria-haspopup="menu" aria-expanded="false"
          aria-label="Order ${esc(r['number'])}. Press Shift+F10 for actions.">
      <td><input type="checkbox" name="ids" value="${esc(r['id'])}" class="rowsel"
            aria-label="Select ${esc(r['number'])}"></td>
      <td>${esc(r['number'])}</td>
      <td><a href="/app/customers/${esc(r['cid'])}">${esc(r['customer'])}</a></td>
      <td>${esc(r['placed_on'])}</td>
      <td>${esc(r['vehicle'])}</td>
      <td>${statusPill(String(r['status']))}</td>
      <td class="num">${money(Number(r['total_cents']))}</td>
    </tr>`,
            )
            .join('')
    }</tbody>
  </table>
</form>

<div class="pager">
  ${page > 1 ? `<a class="btn" href="${link({ page: String(page - 1) })}">Previous</a>` : `<span class="btn" aria-disabled="true">Previous</span>`}
  ${page < pages ? `<a class="btn" href="${link({ page: String(page + 1) })}">Next</a>` : `<span class="btn" aria-disabled="true">Next</span>`}
  <span class="muted">Showing ${total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE_SIZE, total)}</span>
</div>
<p class="muted" style="font-size:12px;margin-top:10px">Right-click a row for actions.</p>`;

  const script = `
(function () {
  var form = document.getElementById('bulkform');
  var host = document.getElementById('bulkbar-host');
  var selAll = document.getElementById('selall');

  function selected() { return Array.prototype.slice.call(form.querySelectorAll('.rowsel:checked')); }

  function renderBar() {
    var n = selected().length;
    if (n === 0) { host.innerHTML = ''; return; }
    // Built fresh each time: the controls genuinely do not exist while the
    // selection is empty.
    host.innerHTML =
      '<div class="bulkbar" role="region" aria-label="Bulk actions">' +
      '<strong id="bulkcount">' + n + ' selected</strong>' +
      '<button type="button" class="btn" data-bulk="deliver">Mark delivered</button>' +
      '<button type="button" class="btn" data-bulk="confirm">Confirm</button>' +
      '<button type="button" class="btn danger" data-bulk="cancel">Cancel orders</button>' +
      '<button type="button" class="btn" data-bulk="clear">Clear selection</button></div>';
  }

  form.addEventListener('change', function (ev) {
    if (ev.target === selAll) {
      form.querySelectorAll('.rowsel').forEach(function (c) { c.checked = selAll.checked; });
    }
    renderBar();
  });

  host.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-bulk]');
    if (!b) return;
    var action = b.getAttribute('data-bulk');
    if (action === 'clear') {
      form.querySelectorAll('.rowsel').forEach(function (c) { c.checked = false; });
      selAll.checked = false;
      renderBar();
      return;
    }
    document.getElementById('bulk_action').value = action;
    form.submit();
  });

  // ---- context menu ------------------------------------------------------
  var menu = null;
  var menuTarget = null;
  function closeMenu(restoreFocus) {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (menuTarget) menuTarget.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuTarget) menuTarget.focus();
    menuTarget = null;
  }

  function openMenu(tr, x, y) {
    closeMenu(false);
    var id = tr.getAttribute('data-order');
    var number = tr.getAttribute('data-number');
    var rect = tr.getBoundingClientRect();
    menuTarget = tr;
    tr.setAttribute('aria-expanded', 'true');
    menu = document.createElement('div');
    menu.className = 'ctxmenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Actions for ' + number);
    menu.style.left = (x == null ? rect.left + 24 : x) + 'px';
    menu.style.top = (y == null ? rect.top + 24 : y) + 'px';
    menu.innerHTML =
      '<div class="ctxhead">' + number + '</div>' +
      '<button type="button" role="menuitem" data-ctx="deliver" data-id="' + id + '">Mark delivered</button>' +
      '<button type="button" role="menuitem" data-ctx="confirm" data-id="' + id + '">Confirm</button>' +
      '<button type="button" role="menuitem" data-ctx="cancel" data-id="' + id + '">Cancel order</button>';
    document.body.appendChild(menu);
    var box = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(parseFloat(menu.style.left), innerWidth - box.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(parseFloat(menu.style.top), innerHeight - box.height - 4)) + 'px';
    menu.querySelector('[role=menuitem]').focus();

    menu.addEventListener('keydown', function (event) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('[role=menuitem]'));
      var index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(false); return; }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1].focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
  }

  document.getElementById('ordertable').addEventListener('contextmenu', function (ev) {
    var tr = ev.target.closest('tr[data-order]');
    if (!tr) return;
    ev.preventDefault();
    openMenu(tr, ev.clientX, ev.clientY);
  });

  document.getElementById('ordertable').addEventListener('keydown', function (ev) {
    var tr = ev.target.closest('tr[data-order]');
    if (!tr || (ev.key !== 'ContextMenu' && !(ev.shiftKey && ev.key === 'F10'))) return;
    ev.preventDefault();
    openMenu(tr);
  });

  document.addEventListener('click', function (ev) {
    var item = ev.target.closest('[data-ctx]');
    if (item) {
      var f = document.createElement('form');
      f.method = 'post';
      f.action = '/app/orders/bulk';
      var action = document.createElement('input');
      action.name = 'bulk_action';
      action.value = item.getAttribute('data-ctx');
      var selectedId = document.createElement('input');
      selectedId.name = 'ids';
      selectedId.value = item.getAttribute('data-id');
      f.appendChild(action);
      f.appendChild(selectedId);
      document.body.appendChild(f);
      f.submit();
      return;
    }
    closeMenu(false);
  });
  window.addEventListener('scroll', function () { closeMenu(false); }, true);
})();`;

  return layout(body, {
    title: 'Orders',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Sales', href: '/app/customers' }, { label: 'Orders' }],
    script,
  });
}

/** Maps a bulk action to the status it sets. */
export const BULK_ACTIONS: Record<string, string> = {
  deliver: 'Delivered',
  confirm: 'Confirmed',
  cancel: 'Cancelled',
};
