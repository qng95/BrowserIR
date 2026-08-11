import type { DatabaseSync } from 'node:sqlite';

import { money } from './db.js';
import { esc, layout, statusPill } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;

export const ROW_HEIGHT = 34;
/** Rows rendered around the viewport. Everything else is a spacer height. */
export const WINDOW = 40;

export interface VehicleQuery {
  q: string;
  status: string;
  sort: string;
  dir: 'asc' | 'desc';
}

const SORTABLE = ['vin', 'make', 'model', 'year', 'mileage_km', 'price_cents', 'status', 'location'];

export function parseVehicleQuery(url: URL): VehicleQuery {
  const sortRaw = url.searchParams.get('sort') ?? 'vin';
  return {
    q: (url.searchParams.get('q') ?? '').trim(),
    status: url.searchParams.get('status') ?? '',
    sort: SORTABLE.includes(sortRaw) ? sortRaw : 'vin',
    dir: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

function whereFor(q: VehicleQuery): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (q.q) {
    parts.push('(vin LIKE ? OR make LIKE ? OR model LIKE ? OR variant LIKE ? OR colour LIKE ?)');
    const like = `%${q.q}%`;
    args.push(like, like, like, like, like);
  }
  if (q.status) {
    parts.push('status = ?');
    args.push(q.status);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

export function countVehicles(db: DatabaseSync, q: VehicleQuery): number {
  const { sql, args } = whereFor(q);
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM vehicles ${sql}`).get(...(args as never[])) as Row).n);
}

export function sliceVehicles(db: DatabaseSync, q: VehicleQuery, offset: number, limit: number): Row[] {
  const { sql, args } = whereFor(q);
  return db
    .prepare(`SELECT * FROM vehicles ${sql} ORDER BY ${q.sort} ${q.dir}, id ASC LIMIT ? OFFSET ?`)
    .all(...([...args, limit, Math.max(0, offset)] as never[])) as Row[];
}

/** One row's markup. Shared by the server render and the API so a recycled row is byte-identical. */
export function vehicleRowHtml(v: Row, index: number): string {
  return `<div class="vrow" role="row" data-index="${index}" data-vehicle="${esc(v['id'])}" style="height:${ROW_HEIGHT}px">
  <div class="vcell vin" role="gridcell">${esc(v['vin'])}</div>
  <div class="vcell make" role="gridcell">${esc(v['make'])}</div>
  <div class="vcell model" role="gridcell">${esc(v['model'])} <span class="muted">${esc(v['variant'])}</span></div>
  <div class="vcell year num" role="gridcell">${esc(v['year'])}</div>
  <div class="vcell km num" role="gridcell">${Number(v['mileage_km']).toLocaleString('de-DE')} km</div>
  <div class="vcell price num" role="gridcell">${money(Number(v['price_cents']))}</div>
  <div class="vcell st" role="gridcell">${statusPill(String(v['status']))}</div>
  <div class="vcell loc" role="gridcell">${esc(v['location'])}</div>
  <div class="vcell act" role="gridcell"><a href="/app/vehicles/${esc(v['id'])}">Open</a></div>
</div>`;
}

const COLUMNS: Array<[string, string, string]> = [
  ['vin', 'VIN', 'vin'],
  ['make', 'Make', 'make'],
  ['model', 'Model', 'model'],
  ['year', 'Year', 'year num'],
  ['mileage_km', 'Mileage', 'km num'],
  ['price_cents', 'Price', 'price num'],
  ['status', 'Status', 'st'],
  ['location', 'Location', 'loc'],
];

/**
 * The inventory screen.
 *
 * Only ~40 of 12,000 rows are ever in the DOM. Scrolling fetches the next
 * window from the server and REUSES the same row nodes, so a reference anchored
 * to a DOM node silently comes to point at a different vehicle. That is the
 * hardest problem for any agent ref scheme, and here it is a property of a
 * screen a dealership would actually ship rather than of a contrived fixture.
 */
export function vehiclesPage(ctx: PageCtx): string {
  const q = parseVehicleQuery(ctx.url);
  const total = countVehicles(ctx.db, q);
  const first = sliceVehicles(ctx.db, q, 0, WINDOW);

  const link = (over: Record<string, string>) => {
    const s = new URLSearchParams(ctx.url.searchParams);
    for (const [k, v] of Object.entries(over)) v ? s.set(k, v) : s.delete(k);
    return `/app/vehicles?${s.toString()}`;
  };

  const header = COLUMNS.map(([key, label, cls]) => {
    const active = q.sort === key;
    const nextDir = active && q.dir === 'asc' ? 'desc' : 'asc';
    return `<div class="vcell ${cls} vhead" role="columnheader"${
      active ? ` aria-sort="${q.dir === 'asc' ? 'ascending' : 'descending'}"` : ''
    }><a href="${link({ sort: key, dir: nextDir })}">${esc(label)}${active ? (q.dir === 'asc' ? ' ▲' : ' ▼') : ''}</a></div>`;
  }).join('');

  const body = `
<div class="toolbar">
  <form method="get" action="/app/vehicles" class="toolbar" style="margin:0">
    <label for="q" class="muted">Search</label>
    <input id="q" name="q" type="text" value="${esc(q.q)}" placeholder="VIN, make, model or colour">
    <label for="status" class="muted">Status</label>
    <select id="status" name="status">
      <option value="">All</option>
      ${['In stock', 'Reserved', 'In transit', 'Sold', 'Demo']
        .map((s) => `<option value="${s}"${q.status === s ? ' selected' : ''}>${s}</option>`)
        .join('')}
    </select>
    <button class="btn" type="submit">Apply</button>
    ${q.q || q.status ? `<a class="btn" href="/app/vehicles">Clear</a>` : ''}
  </form>
</div>

<p class="muted" role="status" id="vcount">${total.toLocaleString('en-US')} vehicles ·
  <span id="vwindow">showing 1–${Math.min(WINDOW, total)}</span></p>

<div class="vgrid" role="grid" aria-rowcount="${total + 1}"
     data-total="${total}" data-window="${WINDOW}" data-row-height="${ROW_HEIGHT}" data-first="0">
  <div class="vrow vheadrow" role="row">${header}</div>
  <div class="vviewport" id="vviewport" tabindex="0">
    <div class="vspacer" style="height:${total * ROW_HEIGHT}px" aria-hidden="true"></div>
    <div class="vcanvas" id="vcanvas" style="transform:translateY(0px)">
      ${first.map((v, i) => vehicleRowHtml(v, i)).join('')}
    </div>
  </div>
</div>
${total === 0 ? '<p class="empty">No vehicles match that filter.</p>' : ''}`;

  const script = `
(function () {
  var grid = document.querySelector('.vgrid');
  var vp = document.getElementById('vviewport');
  var canvas = document.getElementById('vcanvas');
  var total = Number(grid.getAttribute('data-total'));
  var win = Number(grid.getAttribute('data-window'));
  var rowH = Number(grid.getAttribute('data-row-height'));
  var inflight = null;

  function sync() {
    var first = Math.max(0, Math.min(Math.max(0, total - win), Math.floor(vp.scrollTop / rowH)));
    if (String(first) === grid.getAttribute('data-first')) return;
    grid.setAttribute('data-first', String(first));
    grid.setAttribute('data-loading', '1');
    var params = new URLSearchParams(location.search);
    params.set('offset', String(first));
    params.set('limit', String(win));
    if (inflight) inflight.abort();
    inflight = new AbortController();
    fetch('/api/vehicles?' + params.toString(), { signal: inflight.signal })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (String(first) !== grid.getAttribute('data-first')) return;
        canvas.innerHTML = d.html;
        canvas.style.transform = 'translateY(' + first * rowH + 'px)';
        grid.removeAttribute('data-loading');
        document.getElementById('vwindow').textContent =
          'showing ' + (first + 1) + '–' + Math.min(first + win, total);
      })
      .catch(function () {});
  }

  // No requestAnimationFrame: it does not run in a background tab, and a great
  // deal of agent automation runs exactly that way.
  vp.addEventListener('scroll', sync);
  setInterval(sync, 250);
})();`;

  return layout(body, {
    title: 'Vehicles',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Inventory', href: '/app/vehicles' }, { label: 'Vehicles' }],
    script,
  });
}

export function vehicleDetailPage(ctx: PageCtx, id: number): string {
  const v = ctx.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as Row | undefined;
  if (!v) {
    return layout(`<div class="card"><h2>Not found</h2><p class="muted">No such vehicle.</p></div>`, {
      title: 'Not found',
      path: ctx.path,
      user: ctx.user,
    });
  }

  const body = `
<div class="card">
  <h2>${esc(v['make'])} ${esc(v['model'])} <span class="muted">${esc(v['variant'])}</span></h2>
  <div class="field"><label>VIN</label><div>${esc(v['vin'])}</div></div>
  <div class="field"><label>Status</label><div>${statusPill(String(v['status']))}</div></div>
  <div class="field"><label>Year</label><div>${esc(v['year'])}</div></div>
  <div class="field"><label>Mileage</label><div>${Number(v['mileage_km']).toLocaleString('de-DE')} km</div></div>
  <div class="field"><label>Price</label><div>${money(Number(v['price_cents']))}</div></div>
  <div class="field"><label>Fuel / gearbox</label><div>${esc(v['fuel'])} · ${esc(v['gearbox'])}</div></div>
  <div class="field"><label>Colour</label><div>${esc(v['colour'])}</div></div>
  <div class="field"><label>Location</label><div>${esc(v['location'])}</div></div>

  <form method="post" action="/app/vehicles/${id}/status" class="toolbar" style="margin-top:12px">
    <label for="vstatus" class="muted">Change status</label>
    <select id="vstatus" name="status">
      ${['In stock', 'Reserved', 'In transit', 'Sold', 'Demo']
        .map((s) => `<option value="${s}"${v['status'] === s ? ' selected' : ''}>${s}</option>`)
        .join('')}
    </select>
    <button class="btn primary" type="submit">Update status</button>
  </form>
</div>

<div class="card">
  <h2>Valuation (legacy system)</h2>
  <p class="muted">Served from the previous DMS. Runs in its own document.</p>
  <iframe class="legacy" title="Legacy valuation tool" height="210"
          src="/legacy/valuation?vin=${encodeURIComponent(String(v['vin']))}"></iframe>
</div>`;

  return layout(body, {
    title: `${String(v['make'])} ${String(v['model'])}`,
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [
      { label: 'Inventory', href: '/app/vehicles' },
      { label: 'Vehicles', href: '/app/vehicles' },
      { label: String(v['vin']) },
    ],
  });
}

/** The old system's valuation widget, served as its own document for the iframe. */
export function legacyValuationPage(vin: string): string {
  const base = 14500 + (vin.length * 137) % 9000;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Valuation</title>
<style>
body{font:13px -apple-system,system-ui,sans-serif;margin:10px;color:#1f2328}
table{border-collapse:collapse;width:100%}
th{text-align:left;background:#f3f5f7;padding:5px 8px;border-bottom:1px solid #d6dbe0;font-size:12.5px}
td{padding:5px 8px;border-bottom:1px solid #f1f3f5}
button{margin-top:8px;padding:5px 12px;border:1px solid #ccd2d8;border-radius:4px;background:#fff;
  cursor:pointer;font:inherit}
</style></head><body>
<p><strong>VIN</strong> ${esc(vin)}</p>
<table>
  <tr><th>Basis</th><th>Amount</th></tr>
  <tr><td>Trade-in base</td><td>${base.toLocaleString('de-DE')} €</td></tr>
  <tr><td>Condition adjustment</td><td>-${(base * 0.08).toFixed(0)} €</td></tr>
  <tr><td>Market demand</td><td>+${(base * 0.03).toFixed(0)} €</td></tr>
</table>
<button type="button" id="recalc" onclick="this.textContent='Recalculated'">Recalculate</button>
</body></html>`;
}
