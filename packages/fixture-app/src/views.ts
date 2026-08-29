/**
 * Server-rendered chrome for the fixture app.
 *
 * Every navigation item here is a real URL that returns a real document. The
 * generator's synthetic page used `href="#/stock"` anchors that changed
 * nothing, which meant an agent could never be asked to *go somewhere* — and
 * "navigate, then verify you arrived" is most of what agent work actually is.
 */

export interface NavItem {
  label: string;
  href?: string;
  children?: NavItem[];
}

export const NAV: NavItem[] = [
  { label: 'Dashboard', children: [{ label: 'Overview', href: '/app/dashboard' }] },
  {
    label: 'Sales',
    children: [
      { label: 'Customers', href: '/app/customers' },
      { label: 'Orders', href: '/app/orders' },
      { label: 'New order', href: '/app/orders/new' },
      { label: 'New customer', href: '/app/customers/new' },
    ],
  },
  {
    label: 'Inventory',
    children: [{ label: 'Vehicles', href: '/app/vehicles' }],
  },
  {
    label: 'Service',
    children: [
      { label: 'Workshop', href: '/app/workshop' },
      { label: 'Parts', href: '/app/parts' },
      { label: 'Tickets', href: '/app/tickets' },
    ],
  },
  {
    label: 'Billing',
    children: [{ label: 'Invoices', href: '/app/invoices' }],
  },
  {
    label: 'Reports',
    children: [
      { label: 'Revenue', href: '/app/reports/revenue' },
      { label: 'Query builder', href: '/app/reports/query' },
      { label: 'Export', href: '/app/reports/export' },
      { label: 'Audit log', href: '/app/reports/audit' },
    ],
  },
];

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface LayoutOptions {
  title: string;
  path: string;
  user?: { username: string; display_name: string } | undefined;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  flash?: { kind: 'ok' | 'error'; text: string } | undefined;
  /** Extra markup placed just before </body>, e.g. a page-specific script. */
  script?: string;
}

function navMarkup(path: string): string {
  return NAV.map((group) => {
    // A group is expanded when the current page lives inside it. Collapsed
    // groups render no children at all — the same "absent, not hidden" shape
    // as the synthetic tree, but here it is genuine routing state.
    const open = (group.children ?? []).some((c) => c.href && path.startsWith(c.href));
    const kids = open
      ? `<ul class="nav-children">${(group.children ?? [])
          .map((c) => {
            const active = c.href === path || (c.href !== '/app/customers/new' && c.href && path.startsWith(c.href + '/'));
            return `<li><a href="${esc(c.href)}"${active ? ' aria-current="page"' : ''}>${esc(c.label)}</a></li>`;
          })
          .join('')}</ul>`
      : '';
    return `<li class="nav-group">
  <a class="nav-head" href="${esc(group.children?.[0]?.href ?? '#')}" aria-expanded="${open}">
    <span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${esc(group.label)}
  </a>${kids}</li>`;
  }).join('');
}

export function layout(body: string, o: LayoutOptions): string {
  const crumbs = (o.breadcrumbs ?? [])
    .map((c, i, a) =>
      i === a.length - 1
        ? `<span aria-current="page">${esc(c.label)}</span>`
        : `<a href="${esc(c.href)}">${esc(c.label)}</a><span class="sep" aria-hidden="true">/</span>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} — Inventory ERP</title>
<style>${CSS}</style>
</head>
<body>
<header class="appbar">
  <a class="brand" href="/app/customers">Inventory ERP</a>
  <div class="spacer"></div>
  ${
    o.user
      ? `<span class="who">${esc(o.user.display_name)}</span>
         <form method="post" action="/app/logout" class="inline"><button type="submit" class="linkish">Sign out</button></form>`
      : `<a href="/app/login">Sign in</a>`
  }
</header>
<div class="shell">
  <nav class="sidenav" aria-label="Main navigation"><ul class="nav">${navMarkup(o.path)}</ul></nav>
  <main class="main">
    ${crumbs ? `<div class="crumbs" aria-label="Breadcrumb">${crumbs}</div>` : ''}
    ${body}
  </main>
</div>
${
  // A real toast: announced politely, then gone. An agent that reads the page
  // several seconds after acting finds no on-screen evidence of the outcome
  // and has to infer it from state — which is the point.
  o.flash
    ? `<div class="toastwrap" aria-live="polite"><div class="toast flash ${o.flash.kind}" role="status">${esc(
        o.flash.text,
      )}<button type="button" class="tclose" aria-label="Dismiss">✕</button></div></div>
<script>
(function () {
  var wrap = document.querySelector('.toastwrap');
  var t = wrap.querySelector('.toast');
  t.querySelector('.tclose').addEventListener('click', function () { wrap.remove(); });
  setTimeout(function () { if (wrap.isConnected) wrap.remove(); }, 5000);
})();
</script>`
    : ''
}
${o.script ? `<script>${o.script}</script>` : ''}
</body>
</html>`;
}

export const CSS = `
*{box-sizing:border-box}
body{margin:0;font:13.5px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1f2328;background:#f6f8fa}
a{color:#0b57d0}
[hidden]{display:none !important}
.appbar{height:48px;display:flex;align-items:center;gap:12px;padding:0 16px;background:#1f3a5f;color:#fff}
.appbar a{color:#fff;text-decoration:none}
.brand{font-weight:600;font-size:15px}
.spacer{flex:1}
.who{opacity:.85;font-size:12.5px}
.inline{display:inline}
.linkish{background:none;border:0;color:#fff;cursor:pointer;font:inherit;text-decoration:underline;padding:0}
.shell{display:flex;align-items:stretch;min-height:calc(100vh - 48px)}
.sidenav{width:224px;flex:none;background:#fff;border-right:1px solid #e3e6ea;padding:10px 8px}
.nav,.nav-children{list-style:none;margin:0;padding:0}
.nav-children{padding-left:20px;margin:2px 0 6px}
.nav-head{display:flex;align-items:center;gap:6px;padding:5px 6px;font-weight:600;color:#22303c;
  text-decoration:none;border-radius:4px}
.nav-head:hover{background:#eef2f7}
.chev{width:12px;color:#7a848d;font-size:10px}
.nav-children a{display:block;padding:4px 8px;border-radius:4px;text-decoration:none}
.nav-children a:hover{background:#eef2f7}
.nav-children a[aria-current=page]{background:#e8f0fe;font-weight:600;color:#0b3ea8}
.main{flex:1;min-width:0;padding:16px 20px}
.crumbs{color:#5a6672;font-size:12.5px;margin-bottom:10px}
.crumbs .sep{margin:0 6px;color:#aab2bb}
.flash{padding:9px 12px;border-radius:5px;margin-bottom:12px;font-size:13px}
.flash.ok{background:#e6f4ea;border:1px solid #b7e1c1;color:#136c31}
.flash.error{background:#fce8e6;border:1px solid #f3b8b2;color:#a50e0e}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:6px;padding:14px 16px;margin-bottom:16px}
.card>h2{margin:0 0 10px;font-size:15px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.btn{padding:6px 13px;border:1px solid #ccd2d8;border-radius:5px;background:#fff;cursor:pointer;
  font:inherit;text-decoration:none;color:#1f2328;display:inline-block}
.btn:hover{background:#f1f4f7}
.btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
.btn.primary:hover{background:#1666d0}
.btn.danger{background:#d93025;border-color:#d93025;color:#fff}
.btn[disabled]{opacity:.5;cursor:default}
input[type=text],input[type=password],input[type=number],select{padding:6px 8px;border:1px solid #ccd2d8;
  border-radius:4px;font:inherit;background:#fff;min-width:0}
input:focus,select:focus{outline:2px solid #1a73e8;outline-offset:-1px}
input[aria-invalid=true]{border-color:#d93025;background:#fff8f7}
.err{color:#a50e0e;font-size:12px;margin-top:3px}
table{border-collapse:collapse;width:100%;background:#fff}
th{text-align:left;background:#f3f5f7;padding:8px 10px;font-weight:600;font-size:12.5px;color:#3d4852;
  border-bottom:1px solid #d6dbe0;white-space:nowrap}
th a{color:inherit;text-decoration:none;display:block}
th a:hover{text-decoration:underline}
td{padding:8px 10px;border-bottom:1px solid #f1f3f5;font-size:13px}
tbody tr:hover{background:#f7f9fb}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11.5px;background:#eef2f7}
.pill.Active{background:#e6f4ea;color:#136c31}
.pill.Prospect{background:#e8f0fe;color:#0b3ea8}
.pill\\.OnHold,.pill.OnHold{background:#fef7e0;color:#7a5900}
.pill.Churned{background:#fce8e6;color:#a50e0e}
.pager{display:flex;gap:6px;align-items:center;margin-top:12px;font-size:13px}
.tabs{display:flex;gap:0;border-bottom:1px solid #d6dbe0;margin:0 0 14px}
.tabs a{padding:8px 15px;text-decoration:none;color:#5a6672;border:1px solid transparent;border-bottom:0;
  margin-bottom:-1px}
.tabs a[aria-current=page]{background:#fff;border-color:#d6dbe0;border-radius:5px 5px 0 0;
  font-weight:600;color:#1f2328}
.field{display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:start;margin-bottom:10px;max-width:640px}
.field>label{padding-top:7px;color:#3d4852}
.muted{color:#7a848d}
.empty{padding:24px;text-align:center;color:#7a848d}
/* Skeleton shown while a lazily-loaded panel is in flight. Real apps show
   these; agents that snapshot too early see them instead of the data. */
.skeleton{padding:12px 0}
.skeleton .bar{height:11px;border-radius:3px;margin:8px 0;
  background:linear-gradient(90deg,#eceff2 25%,#f6f8fa 37%,#eceff2 63%);
  background-size:400% 100%;animation:sk 1.2s ease infinite}
@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}
.spinner{width:15px;height:15px;border:2px solid #ccd2d8;border-top-color:#1a73e8;border-radius:50%;
  display:inline-block;animation:spin .7s linear infinite;vertical-align:-2px}
@keyframes spin{to{transform:rotate(360deg)}}
.login{max-width:340px;margin:64px auto}
.login .card{padding:20px}
.hint{font-size:12px;color:#7a848d;margin-top:10px}
.legacy{width:100%;border:1px solid #eceff2;border-radius:4px;background:#fff;display:block}

/* ---- virtualised inventory grid ---- */
.vgrid{background:#fff;border:1px solid #d6dbe0;border-radius:6px;overflow:hidden}
.vgrid[data-loading] .vcanvas{opacity:.45;transition:opacity .1s}
.vrow{display:flex;align-items:center;border-bottom:1px solid #f1f3f5}
.vheadrow{background:#f3f5f7;border-bottom:1px solid #d6dbe0;height:36px;font-weight:600;font-size:12.5px}
.vhead a{color:#3d4852;text-decoration:none;display:block}
.vhead a:hover{text-decoration:underline}
.vcell{padding:0 10px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:none;font-size:13px}
.vcell.vin{width:180px;font-variant-numeric:tabular-nums}
.vcell.make{width:130px}
.vcell.model{width:230px}
.vcell.year{width:70px}
.vcell.km{width:110px}
.vcell.price{width:110px}
.vcell.st{width:110px}
.vcell.loc{width:170px}
.vcell.act{width:70px}
.vviewport{height:520px;overflow:auto;position:relative}
.vcanvas{position:absolute;top:0;left:0;right:0}
.vspacer{width:1px}
.vrow:hover{background:#f7f9fb}

/* ---- wizard ---- */
.stepper{list-style:none;display:flex;gap:8px;margin:0 0 16px;padding:0;flex-wrap:wrap}
.stepper li{display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:20px;
  background:#f1f4f7;color:#5a6672;font-size:12.5px}
.stepper li .n{width:19px;height:19px;border-radius:50%;background:#ccd2d8;color:#fff;
  display:grid;place-items:center;font-size:11px}
.stepper li.current{background:#e8f0fe;color:#0b3ea8;font-weight:600}
.stepper li.current .n{background:#1a73e8}
.stepper li.done .n{background:#34a853}

/* ---- combobox / autocomplete ---- */
.combo{position:relative;max-width:420px}
.combo input{width:100%}
.combo [role=listbox]{position:absolute;top:100%;left:0;right:0;z-index:60;max-height:230px;overflow:auto;
  border:1px solid #ccd2d8;border-top:0;background:#fff;box-shadow:0 8px 22px rgba(0,0,0,.14);border-radius:0 0 4px 4px}
.opt{padding:7px 10px;cursor:pointer}
.opt:hover,.opt[aria-selected=true],.opt:focus{background:#eef2f7;outline:none}
.opt.error,.empty.error{color:#a50e0e}

/* ---- modal ---- */
.modal .backdrop{position:fixed;inset:0;background:rgba(15,23,32,.45);z-index:1000}
.modal .dialog{position:fixed;top:8%;left:50%;transform:translateX(-50%);width:min(680px,92vw);
  max-height:80vh;display:flex;flex-direction:column;background:#fff;border-radius:8px;
  box-shadow:0 18px 50px rgba(0,0,0,.3);z-index:1001}
.modal header{display:flex;justify-content:space-between;align-items:center;padding:13px 16px;
  border-bottom:1px solid #eceff2}
.modal header h3{margin:0;font-size:15px}
.modal .x{border:0;background:none;cursor:pointer;font-size:15px;color:#5a6672;padding:4px 8px;border-radius:4px}
.modal .x:hover{background:#f1f4f7}
.modal .dbody{padding:14px 16px;overflow:auto}
.modal .dbody input{width:100%;margin-bottom:10px}
.results{border:1px solid #eceff2;border-radius:5px;max-height:44vh;overflow:auto}
.results .opt{border-bottom:1px solid #f4f6f8}
.results .opt[data-sold]{opacity:.55}

/* ---- toasts ---- */
.toastwrap{position:fixed;top:60px;right:18px;z-index:2000;display:flex;flex-direction:column;gap:8px}
.toast{display:flex;align-items:center;gap:12px;min-width:260px;max-width:380px;margin:0;
  box-shadow:0 8px 26px rgba(0,0,0,.18)}
.tclose{border:0;background:none;cursor:pointer;color:inherit;opacity:.6;font-size:12px;margin-left:auto}
.tclose:hover{opacity:1}

/* ---- bulk selection ---- */
.bulkbar{display:flex;align-items:center;gap:8px;padding:9px 12px;margin-bottom:10px;
  background:#e8f0fe;border:1px solid #b9d0f7;border-radius:6px;flex-wrap:wrap}
.bulkbar strong{margin-right:4px}

/* ---- context menu ---- */
.ctxmenu{position:fixed;z-index:1500;min-width:190px;background:#fff;border:1px solid #d6dbe0;
  border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,.22);padding:5px;overflow:hidden}
.ctxhead{padding:5px 10px;font-size:11.5px;color:#7a848d;border-bottom:1px solid #f1f3f5;margin-bottom:4px}
.ctxmenu button{display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:none;
  cursor:pointer;font:inherit;border-radius:4px}
.ctxmenu button:hover,.ctxmenu button:focus{background:#eef2f7;outline:2px solid #1a73e8;outline-offset:-2px}
tr[data-order]:focus{outline:2px solid #1a73e8;outline-offset:-2px}

/* ---- long-running job ---- */
.progress{height:9px;background:#eceff2;border-radius:5px;overflow:hidden;margin:10px 0}
.progress > i{display:block;height:100%;background:#1a73e8;width:0;transition:width .25s}

/* ---- workshop scheduler ---- */
.schedwrap{overflow-x:auto}
.sched{border-collapse:collapse;min-width:900px}
.sched th{background:#f3f5f7;border:1px solid #e3e6ea;padding:5px 8px;font-size:12px;text-align:center}
.sched th.bay{text-align:left;width:90px;position:sticky;left:0;z-index:1}
.sched th.slot{font-weight:500;color:#5a6672}
.sched td{border:1px solid #eceff2;padding:3px;vertical-align:top;width:110px;height:56px}
.sched td.free{background:#fbfcfd}
.sched td.over{background:#e8f0fe;outline:2px dashed #1a73e8;outline-offset:-3px}
.appt{background:#e8f0fe;border:1px solid #b9d0f7;border-radius:5px;padding:5px 7px;cursor:grab;
  font-size:12px;display:flex;flex-direction:column;gap:2px;height:100%}
.appt:hover{background:#dbe8fd}
.appt.dragging{opacity:.4}
.appt.picked{outline:2px solid #1a73e8;outline-offset:1px}
.appt strong{font-weight:600}

/* ---- master-detail ---- */
.masterdetail{display:grid;grid-template-columns:200px minmax(0,1fr) 300px;gap:14px;align-items:start}
.mdtree,.mdlist,.mddetail{background:#fff;border:1px solid #e3e6ea;border-radius:6px;padding:10px}
.mdlist{padding:0;overflow:hidden}
.mdlist tr[aria-selected=true]{background:#e8f0fe}
.mddetail .card{border:0;padding:0;margin:0}
td.low{color:#a50e0e;font-weight:600}

/* ---- dashboard ---- */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.tile{background:#fff;border:1px solid #e3e6ea;border-radius:6px;padding:14px 16px}
.tlabel{color:#5a6672;font-size:12.5px;margin-bottom:6px}
.tvalue{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;min-height:29px}
.tl{list-style:none;margin:0;padding:0}
.tl li{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid #f4f6f8;font-size:12.5px}
.tl time{flex:0 0 46px;color:#7a848d}

/* ---- query builder ---- */
.frow{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.frow select,.frow input{min-width:150px}

/* ---- inline edit ---- */
td.editable{cursor:cell}
td.editable:hover{background:#f1f4f7;outline:1px dashed #b9d0f7;outline-offset:-2px}
td.editable:focus{background:#f1f4f7;outline:2px solid #1a73e8;outline-offset:-2px}
tr[aria-selected=true]{background:#e8f0fe}
@media (max-width:1100px){.masterdetail{grid-template-columns:1fr}}
`;

export function statusPill(status: string): string {
  return `<span class="pill ${esc(status.replace(/\s+/g, ''))}">${esc(status)}</span>`;
}
