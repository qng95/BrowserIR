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

/** Parse the wizard's euro amount without introducing floating-point cents. */
export function parseDepositCents(value: string | undefined): number | undefined {
  const text = (value ?? '').trim();
  if (text === '') return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined;
  const [whole = '0', fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : undefined;
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

    if (parseDepositCents(v['deposit']) === undefined) {
      e['deposit'] = 'Deposit must be a non-negative amount with at most two decimal places.';
    }
    if ((v['notes'] ?? '').length > 500) e['notes'] = 'Notes must be 500 characters or fewer.';
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
  var request = null;
  var sequence = 0;
  var active = -1;

  function options() { return Array.prototype.slice.call(list.querySelectorAll('[role=option]')); }
  function setActive(index) {
    var items = options();
    if (!items.length) return;
    active = (index + items.length) % items.length;
    items.forEach(function (item, i) { item.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }
  function close() {
    clearTimeout(timer);
    timer = null;
    sequence += 1;
    if (request) request.abort();
    request = null;
    active = -1;
    list.hidden = true;
    list.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function choose(opt) {
    hiddenId.value = opt.getAttribute('data-id');
    input.value = opt.getAttribute('data-name');
    close();
  }

  input.addEventListener('input', function () {
    hiddenId.value = '';
    clearTimeout(timer);
    sequence += 1;
    if (request) request.abort();
    var term = input.value.trim();
    if (term.length < 2) return close();
    // Debounced, exactly like a real typeahead — an agent that types and reads
    // immediately sees nothing.
    timer = setTimeout(function () {
      var requestSequence = sequence;
      request = new AbortController();
      list.hidden = false;
      list.innerHTML = '<div class="opt muted" role="status">Searching…</div>';
      input.setAttribute('aria-expanded', 'true');
      fetch('/api/customers/search?q=' + encodeURIComponent(term), { signal: request.signal })
        .then(function (r) { if (!r.ok) throw new Error('Request failed'); return r.json(); })
        .then(function (d) {
          if (requestSequence !== sequence || input.value.trim() !== term) return;
          active = -1;
          if (!d.items.length) { list.innerHTML = '<div class="opt muted">No matches</div>'; return; }
          list.innerHTML = '';
          d.items.forEach(function (c, index) {
            var opt = document.createElement('div');
            opt.className = 'opt';
            opt.id = 'cust-option-' + requestSequence + '-' + index;
            opt.setAttribute('role', 'option');
            opt.setAttribute('aria-selected', 'false');
            opt.setAttribute('data-id', c.id);
            opt.setAttribute('data-name', c.name);
            opt.appendChild(document.createTextNode(c.number + ' — ' + c.name + ' '));
            var city = document.createElement('span');
            city.className = 'muted';
            city.textContent = c.city;
            opt.appendChild(city);
            list.appendChild(opt);
          });
        })
        .catch(function (error) {
          if (error.name === 'AbortError' || requestSequence !== sequence) return;
          list.innerHTML = '<div class="opt error" role="alert">Could not load customers. Try again.</div>';
        });
    }, 350);
  });

  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
    var items = options();
    if (!items.length) return;
    ev.preventDefault();
    if (ev.key === 'Enter') { choose(items[Math.max(0, active)]); return; }
    setActive(active + (ev.key === 'ArrowDown' ? 1 : -1));
  });

  list.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[data-id]');
    if (!opt) return;
    choose(opt);
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
      <input id="veh-q" type="text" role="combobox" aria-autocomplete="list" aria-controls="veh-results"
             aria-expanded="true" placeholder="Filter by VIN, make or model…" autocomplete="off">
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
  var opener = document.getElementById('veh-open');
  var timer = null;
  var request = null;
  var sequence = 0;
  var active = -1;

  function options() { return Array.prototype.slice.call(results.querySelectorAll('[role=option]')); }
  function setActive(index) {
    var items = options();
    if (!items.length) return;
    active = (index + items.length) % items.length;
    items.forEach(function (item, i) { item.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
    q.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }

  function closeModal(restoreFocus) {
    clearTimeout(timer);
    sequence += 1;
    if (request) request.abort();
    request = null;
    active = -1;
    q.removeAttribute('aria-activedescendant');
    q.setAttribute('aria-expanded', 'false');
    modal.hidden = true;
    if (restoreFocus) opener.focus();
  }

  function choose(opt) {
    document.getElementById('veh-id').value = opt.getAttribute('data-id');
    document.getElementById('veh-summary').innerHTML = opt.innerHTML;
    closeModal(true);
  }

  function load() {
    sequence += 1;
    var requestSequence = sequence;
    var term = q.value.trim();
    if (request) request.abort();
    request = new AbortController();
    active = -1;
    q.removeAttribute('aria-activedescendant');
    results.setAttribute('aria-busy', 'true');
    results.setAttribute('data-state', 'loading');
    results.innerHTML = '<div class="skeleton"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>';
    fetch('/api/vehicles/pick?q=' + encodeURIComponent(term), { signal: request.signal })
      .then(function (r) { if (!r.ok) throw new Error('Request failed'); return r.json(); })
      .then(function (d) {
        if (requestSequence !== sequence || q.value.trim() !== term || modal.hidden) return;
        results.removeAttribute('aria-busy');
        results.setAttribute('data-state', 'ready');
        results.innerHTML = '';
        if (!d.items.length) { results.innerHTML = '<p class="empty">No vehicles match.</p>'; return; }
        d.items.forEach(function (v, index) {
          var opt = document.createElement('div');
          opt.className = 'opt';
          opt.id = 'veh-option-' + requestSequence + '-' + index;
          opt.setAttribute('role', 'option');
          opt.setAttribute('aria-selected', 'false');
          opt.setAttribute('data-id', v.id);
          if (v.status === 'Sold') opt.setAttribute('data-sold', '1');
          var strong = document.createElement('strong');
          strong.textContent = v.make + ' ' + v.model;
          opt.appendChild(strong);
          opt.appendChild(document.createTextNode(' ' + v.variant));
          opt.appendChild(document.createElement('br'));
          var details = document.createElement('span');
          details.className = 'muted';
          details.textContent = v.vin + ' · ' + v.status + ' · ' + v.price;
          opt.appendChild(details);
          results.appendChild(opt);
        });
      })
      .catch(function (error) {
        if (error.name === 'AbortError' || requestSequence !== sequence || modal.hidden) return;
        results.removeAttribute('aria-busy');
        results.setAttribute('data-state', 'error');
        results.innerHTML = '<p class="empty error" role="alert">Could not load vehicles. Try again.</p>';
      });
  }

  opener.addEventListener('click', function () {
    modal.hidden = false;
    q.setAttribute('aria-expanded', 'true');
    load();
    q.focus();
  });
  modal.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-close-modal]')) closeModal(true);
  });
  q.addEventListener('input', function () {
    clearTimeout(timer);
    sequence += 1;
    if (request) request.abort();
    timer = setTimeout(load, 300);
  });
  q.addEventListener('keydown', function (ev) {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
    var items = options();
    if (!items.length) return;
    ev.preventDefault();
    if (ev.key === 'Enter') { choose(items[Math.max(0, active)]); return; }
    setActive(active + (ev.key === 'ArrowDown' ? 1 : -1));
  });

  modal.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeModal(true); return; }
    if (ev.key !== 'Tab') return;
    var focusable = Array.prototype.slice.call(
      modal.querySelectorAll('button:not([disabled]),input:not([disabled])')
    );
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });

  results.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[data-id]');
    if (!opt) return;
    choose(opt);
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
  <div><input id="deposit" name="deposit" type="number" min="0" step="0.01" value="${esc(values['deposit'] ?? '')}"
        ${errors['deposit'] ? ' aria-invalid="true"' : ''}>${err('deposit')}</div>
</div>
<div class="field">
  <label for="notes">Notes</label>
  <div><input id="notes" name="notes" type="text" maxlength="500" value="${esc(values['notes'] ?? '')}"
        ${errors['notes'] ? ' aria-invalid="true"' : ''}>${err('notes')}</div>
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
