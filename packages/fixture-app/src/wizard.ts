import { money } from './db.js';
import { esc, layout } from './views.js';
import type { PageCtx } from './pages.js';

type Row = Record<string, unknown>;

export const STEPS = ['customer', 'vehicle', 'details', 'review'] as const;
export type Step = (typeof STEPS)[number];

export interface WizardState {
  step: Step;
  values: Record<string, string>;
  errors: Record<string, string>;
}

/**
 * A classic multi-step order wizard.
 *
 * State travels in hidden fields rather than session storage, so every step is
 * a real POST to a real URL and the back button works — the shape most
 * enterprise wizards actually have. For an agent this is the hardest common
 * flow: it has to carry information forward across four documents, and a step
 * that fails validation must not lose the three steps already completed.
 */
export function validateStep(step: Step, v: Record<string, string>, db: PageCtx['db']): Record<string, string> {
  const e: Record<string, string> = {};

  if (step === 'customer') {
    const id = Number(v['customer_id']);
    if (!v['customer_id']) e['customer_id'] = 'Choose a customer before continuing.';
    else if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) {
      e['customer_id'] = 'That customer no longer exists.';
    }
  }

  if (step === 'vehicle') {
    const id = Number(v['vehicle_id']);
    if (!v['vehicle_id']) e['vehicle_id'] = 'Choose a vehicle before continuing.';
    else {
      const veh = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id) as Row | undefined;
      if (!veh) e['vehicle_id'] = 'That vehicle no longer exists.';
      // A rule you can only learn by hitting it.
      else if (veh['status'] === 'Sold') e['vehicle_id'] = 'This vehicle is already sold. Pick another.';
    }
  }

  if (step === 'details') {
    const date = v['delivery_on'] ?? '';
    if (!date) e['delivery_on'] = 'Delivery date is required.';
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e['delivery_on'] = 'Use the format YYYY-MM-DD.';
    else if (date < '2026-08-01') e['delivery_on'] = 'Earliest available delivery date is 2026-08-01.';

    const deposit = Number(v['deposit']);
    if (v['deposit'] && (!Number.isFinite(deposit) || deposit < 0)) {
      e['deposit'] = 'Deposit must be a positive number.';
    }
  }

  return e;
}

function hidden(values: Record<string, string>, except: string[]): string {
  return Object.entries(values)
    .filter(([k, v]) => v !== '' && v !== undefined && !except.includes(k))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
}

function stepper(current: Step): string {
  return `<ol class="stepper">${STEPS.map((s, i) => {
    const state = s === current ? 'current' : STEPS.indexOf(current) > i ? 'done' : 'todo';
    return `<li class="${state}"${s === current ? ' aria-current="step"' : ''}>
      <span class="n">${i + 1}</span>${s[0]!.toUpperCase() + s.slice(1)}</li>`;
  }).join('')}</ol>`;
}

export function wizardPage(ctx: PageCtx, state: WizardState): string {
  const { step, values, errors } = state;
  const err = (k: string) => (errors[k] ? `<div class="err" id="err-${k}">${esc(errors[k])}</div>` : '');
  let inner = '';
  let script: string | undefined;

  if (step === 'customer') {
    const chosen = values['customer_id']
      ? (ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(values['customer_id'])) as Row | undefined)
      : undefined;

    // An autocomplete whose options do not exist in the DOM until the user
    // types, and which is backed by a server query. The classic case where a
    // snapshot of the closed control reveals none of its possible values.
    inner = `
<div class="field">
  <label for="cust-input">Customer</label>
  <div>
    <div class="combo" data-combo>
      <input id="cust-input" type="text" role="combobox" aria-expanded="false" aria-autocomplete="list"
             aria-controls="cust-list" autocomplete="off" placeholder="Type at least 2 characters…"
             value="${esc(chosen ? String(chosen['name']) : '')}"${errors['customer_id'] ? ' aria-invalid="true"' : ''}>
      <div id="cust-list" role="listbox" hidden></div>
    </div>
    <input type="hidden" name="customer_id" id="cust-id" value="${esc(values['customer_id'] ?? '')}">
    ${err('customer_id')}
    ${chosen ? `<p class="muted" id="cust-chosen">Selected: ${esc(chosen['number'])} — ${esc(chosen['name'])}</p>` : ''}
  </div>
</div>`;
    script = `
(function () {
  var input = document.getElementById('cust-input');
  var list = document.getElementById('cust-list');
  var hiddenId = document.getElementById('cust-id');
  var timer = null;

  function close() { list.hidden = true; list.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); }

  input.addEventListener('input', function () {
    hiddenId.value = '';
    clearTimeout(timer);
    var term = input.value.trim();
    if (term.length < 2) return close();
    // Debounced, exactly like a real typeahead — an agent that types and reads
    // immediately sees nothing.
    timer = setTimeout(function () {
      list.hidden = false;
      list.innerHTML = '<div class="opt muted" role="status">Searching…</div>';
      input.setAttribute('aria-expanded', 'true');
      fetch('/api/customers/search?q=' + encodeURIComponent(term))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.items.length) { list.innerHTML = '<div class="opt muted">No matches</div>'; return; }
          list.innerHTML = d.items.map(function (c) {
            return '<div class="opt" role="option" tabindex="-1" data-id="' + c.id + '">' +
              c.number + ' — ' + c.name + ' <span class="muted">' + c.city + '</span></div>';
          }).join('');
        });
    }, 350);
  });

  list.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[data-id]');
    if (!opt) return;
    hiddenId.value = opt.getAttribute('data-id');
    input.value = opt.textContent.split(' — ')[1].replace(/\\s+[A-ZÄÖÜ][a-zäöüß]+$/, '').trim();
    close();
  });

  document.addEventListener('click', function (ev) { if (!ev.target.closest('[data-combo]')) close(); });
})();`;
  }

  if (step === 'vehicle') {
    const chosen = values['vehicle_id']
      ? (ctx.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(values['vehicle_id'])) as Row | undefined)
      : undefined;

    inner = `
<div class="field">
  <label>Vehicle</label>
  <div>
    <div id="veh-summary">${
      chosen
        ? `<strong>${esc(chosen['make'])} ${esc(chosen['model'])}</strong> ${esc(chosen['variant'])}<br>
           <span class="muted">${esc(chosen['vin'])} · ${esc(chosen['status'])} · ${money(Number(chosen['price_cents']))}</span>`
        : `<span class="muted">No vehicle selected.</span>`
    }</div>
    <input type="hidden" name="vehicle_id" id="veh-id" value="${esc(values['vehicle_id'] ?? '')}">
    ${err('vehicle_id')}
    <button type="button" class="btn" id="veh-open" style="margin-top:8px">Choose vehicle…</button>
  </div>
</div>

<!-- Rendered at body level, outside the form, like every real modal. -->
<div id="veh-modal" class="modal" hidden>
  <div class="backdrop" data-close-modal></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Choose vehicle">
    <header><h3>Choose vehicle</h3><button type="button" class="x" data-close-modal aria-label="Close">✕</button></header>
    <div class="dbody">
      <input id="veh-q" type="text" placeholder="Filter by VIN, make or model…" autocomplete="off">
      <div id="veh-results" class="results" role="listbox" aria-busy="true">
        <div class="skeleton"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
      </div>
    </div>
  </div>
</div>`;
    script = `
(function () {
  var modal = document.getElementById('veh-modal');
  var results = document.getElementById('veh-results');
  var q = document.getElementById('veh-q');
  var timer = null;

  function load() {
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="skeleton"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';
    fetch('/api/vehicles/pick?q=' + encodeURIComponent(q.value.trim()))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        results.removeAttribute('aria-busy');
        results.innerHTML = d.items.length
          ? d.items.map(function (v) {
              return '<div class="opt" role="option" tabindex="-1" data-id="' + v.id + '"' +
                (v.status === 'Sold' ? ' data-sold="1"' : '') + '>' +
                '<strong>' + v.make + ' ' + v.model + '</strong> ' + v.variant +
                '<br><span class="muted">' + v.vin + ' · ' + v.status + ' · ' + v.price + '</span></div>';
            }).join('')
          : '<p class="empty">No vehicles match.</p>';
      });
  }

  document.getElementById('veh-open').addEventListener('click', function () {
    modal.hidden = false;
    load();
    q.focus();
  });
  modal.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-close-modal]')) modal.hidden = true;
  });
  q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 300); });

  results.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[data-id]');
    if (!opt) return;
    document.getElementById('veh-id').value = opt.getAttribute('data-id');
    document.getElementById('veh-summary').innerHTML = opt.innerHTML;
    modal.hidden = true;
  });
})();`;
  }

  if (step === 'details') {
    inner = `
<div class="field">
  <label for="delivery_on">Delivery date</label>
  <div><input id="delivery_on" name="delivery_on" type="text" placeholder="YYYY-MM-DD"
        value="${esc(values['delivery_on'] ?? '')}"${errors['delivery_on'] ? ' aria-invalid="true"' : ''}>
    ${err('delivery_on')}<div class="muted" style="font-size:12px">Earliest available slot is 2026-08-01.</div></div>
</div>
<div class="field">
  <label for="deposit">Deposit (€)</label>
  <div><input id="deposit" name="deposit" type="number" value="${esc(values['deposit'] ?? '')}"
        ${errors['deposit'] ? ' aria-invalid="true"' : ''}>${err('deposit')}</div>
</div>
<div class="field">
  <label for="notes">Notes</label>
  <div><input id="notes" name="notes" type="text" value="${esc(values['notes'] ?? '')}"></div>
</div>`;
  }

  if (step === 'review') {
    const c = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(values['customer_id'])) as Row;
    const v = ctx.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(values['vehicle_id'])) as Row;
    inner = `
<table style="max-width:620px">
  <tr><th>Customer</th><td>${esc(c['number'])} — ${esc(c['name'])}, ${esc(c['city'])}</td></tr>
  <tr><th>Vehicle</th><td>${esc(v['make'])} ${esc(v['model'])} ${esc(v['variant'])}<br>
      <span class="muted">${esc(v['vin'])}</span></td></tr>
  <tr><th>Price</th><td>${money(Number(v['price_cents']))}</td></tr>
  <tr><th>Delivery</th><td>${esc(values['delivery_on'])}</td></tr>
  <tr><th>Deposit</th><td>${values['deposit'] ? esc(values['deposit']) + ' €' : '—'}</td></tr>
  <tr><th>Notes</th><td>${esc(values['notes'] ?? '') || '—'}</td></tr>
</table>
<p class="muted" style="margin-top:12px">Submitting creates the order and reserves the vehicle.</p>`;
  }

  const idx = STEPS.indexOf(step);
  const body = `
<div class="card">
  <h2>New order</h2>
  ${stepper(step)}
  ${Object.keys(errors).length ? `<div class="flash error" role="alert">Please correct the highlighted field.</div>` : ''}
  <form method="post" action="/app/orders/new">
    <input type="hidden" name="step" value="${step}">
    ${hidden(values, step === 'customer' ? ['customer_id'] : step === 'vehicle' ? ['vehicle_id'] : step === 'details' ? ['delivery_on', 'deposit', 'notes'] : [])}
    ${inner}
    <div class="toolbar" style="margin-top:14px">
      ${idx > 0 ? `<button class="btn" type="submit" name="back" value="1">Back</button>` : `<a class="btn" href="/app/orders">Cancel</a>`}
      <button class="btn primary" type="submit">${step === 'review' ? 'Create order' : 'Continue'}</button>
    </div>
  </form>
</div>`;

  return layout(body, {
    title: 'New order',
    path: ctx.path,
    user: ctx.user,
    flash: ctx.flash,
    breadcrumbs: [{ label: 'Sales', href: '/app/customers' }, { label: 'Orders', href: '/app/orders' }, { label: 'New' }],
    ...(script ? { script } : {}),
  });
}
