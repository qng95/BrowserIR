import { esc, layout } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;

export const DAYS = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
export const SLOTS = ['08:00', '10:30', '13:00', '15:30'];

/**
 * The workshop scheduler.
 *
 * Appointments are moved between bays and time slots by dragging. Drag and drop
 * is the one interaction common in enterprise software that no existing agent
 * benchmark exercises — it has no accessible-tree representation at all, cannot
 * be performed by clicking, and the drop target only reveals itself while a
 * drag is in progress.
 *
 * There is also a keyboard path (select a card, then activate a cell), because
 * a real scheduler has one and because it lets an agent that cannot drag still
 * complete the task by another route. Which route was taken is recorded, so the
 * two can be scored separately.
 */
export function workshopPage(ctx: PageCtx): string {
  const bays = ctx.db.prepare('SELECT * FROM bays ORDER BY id').all() as Row[];
  const appts = ctx.db
    .prepare(
      `SELECT a.*, c.name AS customer FROM appointments a
       LEFT JOIN customers c ON c.id = a.customer_id`,
    )
    .all() as Row[];

  const byCell = new Map<string, Row>();
  for (const a of appts) byCell.set(`${a['bay_id']}|${a['day']}|${a['slot']}`, a);

  const dayHeader = DAYS.map((d) => `<th colspan="${SLOTS.length}">${esc(d)}</th>`).join('');
  const slotHeader = DAYS.map(() => SLOTS.map((s) => `<th class="slot">${esc(s)}</th>`).join('')).join('');

  const rows = bays
    .map((bay) => {
      const cells = DAYS.map((day) =>
        SLOTS.map((_, slot) => {
          const a = byCell.get(`${bay['id']}|${day}|${slot}`);
          const cellAttrs =
            `class="cell${a ? ' filled' : ' free'}" data-bay="${esc(bay['id'])}" ` +
            `data-day="${esc(day)}" data-slot="${slot}"` +
            (a ? '' : ' data-drop="1" tabindex="0" role="button" aria-label="Empty slot"');
          const card = a
            ? `<div class="appt" draggable="true" data-appt="${esc(a['id'])}" tabindex="0" role="button"
                    aria-label="${esc(a['description'])} for ${esc(a['customer'])}">
                 <strong>${esc(a['description'])}</strong>
                 <span class="muted">${esc(a['customer'])}</span>
               </div>`
            : '';
          return `<td ${cellAttrs}>${card}</td>`;
        }).join(''),
      ).join('');
      return `<tr><th class="bay">${esc(bay['name'])}</th>${cells}</tr>`;
    })
    .join('');

  const body = `
<div class="card">
  <h2>Workshop schedule</h2>
  <p class="muted">Drag an appointment onto an empty slot to reschedule it.
     Keyboard: focus a card, press Enter, then focus a slot and press Enter again.</p>
  <div class="schedwrap">
    <table class="sched" id="sched">
      <thead>
        <tr><th class="bay"></th>${dayHeader}</tr>
        <tr><th class="bay">Bay</th>${slotHeader}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="muted" id="schedhint" role="status" aria-live="polite"></p>
</div>`;

  const script = `
(function () {
  var sched = document.getElementById('sched');
  var hint = document.getElementById('schedhint');
  var picked = null;

  function move(apptId, cell, method) {
    var f = document.createElement('form');
    f.method = 'post';
    f.action = '/app/workshop/move';
    f.innerHTML =
      '<input name="appointment_id" value="' + apptId + '">' +
      '<input name="bay_id" value="' + cell.getAttribute('data-bay') + '">' +
      '<input name="day" value="' + cell.getAttribute('data-day') + '">' +
      '<input name="slot" value="' + cell.getAttribute('data-slot') + '">' +
      '<input name="method" value="' + method + '">';
    document.body.appendChild(f);
    f.submit();
  }

  // ---- pointer drag ------------------------------------------------------
  sched.addEventListener('dragstart', function (ev) {
    var card = ev.target.closest('.appt');
    if (!card) return;
    ev.dataTransfer.setData('text/plain', card.getAttribute('data-appt'));
    ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  sched.addEventListener('dragend', function (ev) {
    var card = ev.target.closest('.appt');
    if (card) card.classList.remove('dragging');
    sched.querySelectorAll('.over').forEach(function (c) { c.classList.remove('over'); });
  });
  sched.addEventListener('dragover', function (ev) {
    var cell = ev.target.closest('[data-drop]');
    if (!cell) return;
    // Only an empty cell accepts a drop, and it only says so mid-drag.
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    cell.classList.add('over');
  });
  sched.addEventListener('dragleave', function (ev) {
    var cell = ev.target.closest('[data-drop]');
    if (cell) cell.classList.remove('over');
  });
  sched.addEventListener('drop', function (ev) {
    var cell = ev.target.closest('[data-drop]');
    if (!cell) return;
    ev.preventDefault();
    var id = ev.dataTransfer.getData('text/plain');
    if (id) move(id, cell, 'drag');
  });

  // ---- pointer drag ------------------------------------------------------
  // HTML5 drag-and-drop alone is not reachable by synthesised mouse input, so
  // an agent driving the browser through CDP could never perform this move —
  // that measures an automation gap, not capability. Modern drag libraries
  // (dnd-kit, react-beautiful-dnd) use pointer events for exactly this reason,
  // so the scheduler supports both.
  var pointerCard = null;
  var lastOver = null;
  var startX = 0;
  var startY = 0;
  var moved = false;

  sched.addEventListener('mousedown', function (ev) {
    var card = ev.target.closest('.appt');
    if (!card || ev.button !== 0) return;
    pointerCard = card;
    startX = ev.clientX;
    startY = ev.clientY;
    moved = false;
    card.classList.add('dragging');
  });

  document.addEventListener('mousemove', function (ev) {
    if (!pointerCard) return;
    if (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4) moved = true;
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    var cell = el && el.closest ? el.closest('[data-drop]') : null;
    if (lastOver && lastOver !== cell) lastOver.classList.remove('over');
    if (cell) cell.classList.add('over');
    lastOver = cell;
  });

  document.addEventListener('mouseup', function (ev) {
    if (!pointerCard) return;
    var card = pointerCard;
    pointerCard = null;
    card.classList.remove('dragging');
    if (lastOver) lastOver.classList.remove('over');
    lastOver = null;
    // A press without movement is a click, not a drag. Without this guard any
    // stray mouseup after touching a card fired a navigation.
    if (!moved) return;
    var el = document.elementFromPoint(ev.clientX, ev.clientY);
    var cell = el && el.closest ? el.closest('[data-drop]') : null;
    if (cell) move(card.getAttribute('data-appt'), cell, 'drag');
  });

  // ---- keyboard path -----------------------------------------------------
  sched.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var card = ev.target.closest('.appt');
    if (card) {
      ev.preventDefault();
      sched.querySelectorAll('.picked').forEach(function (c) { c.classList.remove('picked'); });
      picked = card.getAttribute('data-appt');
      card.classList.add('picked');
      hint.textContent = 'Appointment picked up. Choose an empty slot and press Enter.';
      return;
    }
    var cell = ev.target.closest('[data-drop]');
    if (cell && picked) {
      ev.preventDefault();
      move(picked, cell, 'keyboard');
    }
  });
})();`;

  return layout(body, {
    title: 'Workshop',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Service', href: '/app/workshop' }, { label: 'Workshop' }],
    script,
  });
}

// ------------------------------------------------------------------ parts --

/**
 * Parts: a master-detail screen over a category tree.
 *
 * Three panes, each driven by the URL — collapsed branches are not rendered,
 * and the detail pane only exists once a part is selected. Reaching a specific
 * part therefore takes three navigations, none of which an agent can shortcut
 * by reading a single snapshot.
 */
export function partsPage(ctx: PageCtx, categoryId?: number, partId?: number): string {
  const roots = ctx.db.prepare('SELECT * FROM part_categories WHERE parent_id IS NULL ORDER BY id').all() as Row[];

  const selected = categoryId
    ? (ctx.db.prepare('SELECT * FROM part_categories WHERE id = ?').get(categoryId) as Row | undefined)
    : undefined;
  const openRoot = selected ? Number(selected['parent_id'] ?? selected['id']) : null;

  const tree = roots
    .map((r) => {
      const open = Number(r['id']) === openRoot;
      const kids = open
        ? (ctx.db.prepare('SELECT * FROM part_categories WHERE parent_id = ? ORDER BY id').all(Number(r['id'])) as Row[])
        : [];
      return `<li data-branch="${esc(r['id'])}">
  <a class="nav-head" href="/app/parts?category=${esc(kids[0]?.['id'] ?? r['id'])}" aria-expanded="${open}">
    <span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${esc(r['name'])}
  </a>
  ${
    open
      ? `<ul class="nav-children">${kids
          .map(
            (k) =>
              `<li><a href="/app/parts?category=${esc(k['id'])}"${
                Number(k['id']) === categoryId ? ' aria-current="page"' : ''
              }>${esc(k['name'])}</a></li>`,
          )
          .join('')}</ul>`
      : ''
  }
</li>`;
    })
    .join('');

  const parts = categoryId
    ? (ctx.db.prepare('SELECT * FROM parts WHERE category_id = ? ORDER BY sku').all(categoryId) as Row[])
    : [];
  const part = partId ? (ctx.db.prepare('SELECT * FROM parts WHERE id = ?').get(partId) as Row | undefined) : undefined;

  const body = `
<div class="masterdetail">
  <nav class="mdtree" aria-label="Part categories"><ul class="nav">${tree}</ul></nav>

  <div class="mdlist">
    ${
      !categoryId
        ? `<p class="empty">Choose a category.</p>`
        : parts.length === 0
          ? `<p class="empty">No parts in this category.</p>`
          : `<table><thead><tr><th>SKU</th><th>Part</th><th>Stock</th><th>Supplier</th></tr></thead><tbody>${parts
              .map(
                (p) => `<tr${Number(p['id']) === partId ? ' aria-selected="true"' : ''}>
      <td><a href="/app/parts?category=${categoryId}&part=${esc(p['id'])}">${esc(p['sku'])}</a></td>
      <td>${esc(p['name'])}</td>
      <td class="num${Number(p['stock']) < Number(p['reorder_level']) ? ' low' : ''}">${esc(p['stock'])}</td>
      <td>${esc(p['supplier'])}</td>
    </tr>`,
              )
              .join('')}</tbody></table>`
    }
  </div>

  <aside class="mddetail">
    ${
      part
        ? `<div class="card">
    <h2>${esc(part['name'])}</h2>
    <div class="field"><label>SKU</label><div>${esc(part['sku'])}</div></div>
    <div class="field"><label>Stock</label><div>${esc(part['stock'])}</div></div>
    <div class="field"><label>Reorder level</label><div>${esc(part['reorder_level'])}</div></div>
    <div class="field"><label>Supplier</label><div>${esc(part['supplier'])}</div></div>
    <form method="post" action="/app/parts/${esc(part['id'])}/restock" class="toolbar">
      <label for="qty" class="muted">Add stock</label>
      <input id="qty" name="qty" type="number" value="20" min="1" style="width:90px">
      <button class="btn primary" type="submit">Restock</button>
    </form>
  </div>`
        : `<p class="empty">Select a part.</p>`
    }
  </aside>
</div>`;

  return layout(body, {
    title: 'Parts',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Service', href: '/app/workshop' }, { label: 'Parts' }],
  });
}
