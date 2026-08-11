import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  BrowserIRRuntime,
  type CompiledView,
  type EntityRef,
  type ObservationResult,
} from '@browserir/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPlaywrightBrowserDriver } from '../src/index.js';
import {
  gradeRepresentation,
  type NormalizedRepresentation,
  type RepresentationContract,
} from './conformance/oracle.js';

type Implementation = 'native' | 'aria' | 'roleless' | 'shadow';

const IMPLEMENTATIONS: readonly Implementation[] = [
  'native',
  'aria',
  'roleless',
  'shadow',
];
const SEEDS = ['alpha', 'bravo'] as const;
const STATUS_OPTIONS = [
  { label: 'Prospect', value: 'prospect' },
  { label: 'Active', value: 'active' },
  { label: 'Suspended', value: 'suspended' },
] as const;

const statusOptionsForSeed = (
  seed: string,
): readonly (typeof STATUS_OPTIONS)[number][] =>
  seed === 'bravo' ? [...STATUS_OPTIONS].reverse() : STATUS_OPTIONS;

const customerStatusContract = (
  selectedValue: string,
): RepresentationContract => ({
  id: `customer-status/${selectedValue}`,
  requireTextParity: true,
  required: [
    {
      key: 'status',
      locate: { name: 'Customer Status' },
      expect: {
        kind: 'input',
        role: 'combobox',
        name: 'Customer Status',
        value: selectedValue,
        state: { visible: true, enabled: true, expanded: false },
        actions: ['contextClick', 'focus', 'hover', 'select'],
      },
    },
    ...STATUS_OPTIONS.map(({ label, value }) => ({
      key: `option-${value}`,
      locate: { kind: 'option', name: label },
      expect: {
        kind: 'option',
        role: 'option',
        name: label,
        value,
        state: { selected: value === selectedValue },
        actions: [],
      },
    })),
  ],
  relations: STATUS_OPTIONS.map(({ value }) => ({
    from: `option-${value}`,
    kind: 'option-of',
    to: 'status',
  })),
  forbidden: [
    {
      label: 'WebForms infrastructure',
      match: { name: '__VIEWSTATE' },
    },
    {
      label: 'WebForms event validation infrastructure',
      match: { name: '__EVENTVALIDATION' },
    },
  ],
  allowedActionables: [
    { name: 'Customer Status' },
    { name: 'Open details' },
  ],
  budget: {
    maxCharacters: 12_000,
    maxUnexpectedActionables: 0,
  },
});

let server: Server;
let origin: string;
let postbackStatus = 'prospect';
let postbackRender = 0;

const html = (body: string, script = ''): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Customer status</title>
    <style>
      body { font: 16px sans-serif; padding: 24px; }
      [role="listbox"][hidden], .choice-list[hidden] { display: none; }
      [role="option"], .choice-option { padding: 6px; cursor: pointer; }
      [role="option"][aria-selected="true"], .choice-option[aria-selected="true"] {
        font-weight: 700;
      }
      .choice-control { border: 1px solid #888; padding: 8px; width: 260px; }
    </style>
  </head>
  <body>
    <main aria-label="Customer editor">
      <h1>Edit customer</h1>
      ${body}
      <output id="result">Current status: Prospect</output>
    </main>
    ${script}
  </body>
</html>`;

const optionMarkup = (
  selectedValue: string,
  roleAttribute: string,
  disabledValue?: string,
  seed = 'alpha',
): string =>
  statusOptionsForSeed(seed).map(
    ({ label, value }) =>
      `<div ${roleAttribute} value="${value}" data-value="${value}" ${
        value === disabledValue ? 'aria-disabled="true"' : ''
      } aria-selected="${
        value === selectedValue ? 'true' : 'false'
      }">${label}</div>`,
  ).join('');

const fieldLayout = (seed: string, field: string): string =>
  seed === 'bravo'
    ? `<div class="legacy-panel">
        <input type="hidden" name="legacy-layout-token" value="opaque">
        <section data-layout="${seed}">
          <div class="legacy-field-row">
            <div class="legacy-field-cell">${field}</div>
          </div>
        </section>
      </div>`
    : `<section data-layout="${seed}">${field}</section>`;

const customChoiceScript = (controlExpression: string, listExpression: string): string => `
<script>
  (() => {
    const control = ${controlExpression};
    const list = ${listExpression};
    const result = document.querySelector('#result');
    const open = () => {
      list.hidden = false;
      control.setAttribute('aria-expanded', 'true');
    };
    const choose = option => {
      const value = option.getAttribute('value') || option.dataset.value;
      control.setAttribute('value', value);
      control.setAttribute('aria-valuetext', option.textContent.trim());
      control.setAttribute('aria-expanded', 'false');
      list.hidden = true;
      list.querySelectorAll('[aria-selected]').forEach(candidate => {
        candidate.setAttribute('aria-selected', String(candidate === option));
      });
      result.textContent = 'Current status: ' + option.textContent.trim();
    };
    control.addEventListener('click', open);
    control.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    list.addEventListener('click', event => {
      const option = event.target.closest('[data-value]');
      if (option) choose(option);
    });
  })();
</script>`;

const renderFixture = (
  implementation: Implementation,
  seed: string,
): string => {
  const suffix = `${seed}-${implementation}`;
  if (implementation === 'native') {
    return html(
      `${fieldLayout(
        seed,
        `
        <label for="status-${suffix}">Customer Status</label>
        <select id="status-${suffix}" name="CustomerStatus">
          ${statusOptionsForSeed(seed)
            .map(
            ({ label, value }) =>
              `<option value="${value}" ${
                value === 'prospect' ? 'selected' : ''
              }>${label}</option>`,
            )
            .join('')}
        </select>
      `,
      )}
      ${
        seed === 'fragment'
          ? '<a href="#details">Open details</a><section id="details">Details</section>'
          : ''
      }`,
      `<script>
        document.querySelector('select').addEventListener('change', event => {
          const selected = event.currentTarget.selectedOptions[0];
          document.querySelector('#result').textContent =
            'Current status: ' + selected.textContent.trim();
        });
      </script>`,
    );
  }

  if (implementation === 'aria') {
    const labelId = `status-label-${suffix}`;
    const controlId = `status-control-${suffix}`;
    const listId = `status-list-${suffix}`;
    return html(
      `${fieldLayout(
        seed,
        `
        <span id="${labelId}">Customer Status</span>
        <div
          id="${controlId}"
          class="choice-control"
          role="combobox"
          tabindex="0"
          aria-labelledby="${labelId}"
          aria-controls="${listId}"
          aria-expanded="false"
          aria-valuetext="Prospect"
          value="prospect"
        >Prospect</div>
        <div id="${listId}" role="listbox" hidden>
          ${optionMarkup(
            'prospect',
            'role="option"',
            seed === 'disabled' ? 'active' : undefined,
            seed,
          )}
        </div>
      `,
      )}`,
      customChoiceScript(
        `document.querySelector('#${controlId}')`,
        `document.querySelector('#${listId}')`,
      ) +
        (seed === 'vanishing'
          ? `<script>
              document.querySelector('#${controlId}').addEventListener(
                'click',
                () => document.querySelector(
                  '#${listId} [data-value="active"]'
                )?.remove(),
                { capture: true }
              );
            </script>`
          : ''),
    );
  }

  if (implementation === 'roleless') {
    const labelId = `status-caption-${suffix}`;
    const controlId = `status-picker-${suffix}`;
    const listId = `status-values-${suffix}`;
    return html(
      `${fieldLayout(
        seed,
        `
        <span id="${labelId}">Customer Status</span>
        <div
          id="${controlId}"
          class="choice-control"
          tabindex="0"
          aria-labelledby="${labelId}"
          aria-haspopup="listbox"
          aria-controls="${listId}"
          aria-expanded="false"
          aria-valuetext="Prospect"
          value="prospect"
        >Prospect</div>
        <div id="${listId}" class="choice-list" hidden>
          ${optionMarkup(
            'prospect',
            'class="choice-option"',
            undefined,
            seed,
          )}
        </div>
      `,
      )}`,
      customChoiceScript(
        `document.querySelector('#${controlId}')`,
        `document.querySelector('#${listId}')`,
      ),
    );
  }

  const portalId = `status-portal-${suffix}`;
  return html(
    `${fieldLayout(
      seed,
      '<customer-status-field></customer-status-field>',
    )}
    <div id="${portalId}" role="listbox" hidden>
      ${optionMarkup('prospect', 'role="option"', undefined, seed)}
    </div>`,
    `<script>
      (() => {
        const host = document.querySelector('customer-status-field');
        const root = host.attachShadow({ mode: 'open' });
        const labelId = 'status-label-${suffix}';
        root.innerHTML = \`
          <style>.choice-control { border: 1px solid #888; padding: 8px; width: 260px; }</style>
          <span id="\${labelId}">Customer Status</span>
          <div
            class="choice-control"
            role="combobox"
            tabindex="0"
            aria-labelledby="\${labelId}"
            aria-controls="${portalId}"
            aria-expanded="false"
            aria-valuetext="Prospect"
            value="prospect"
          >Prospect</div>
        \`;
        const control = root.querySelector('[role="combobox"]');
        const list = document.querySelector('#${portalId}');
        const result = document.querySelector('#result');
        const open = () => {
          list.hidden = false;
          control.setAttribute('aria-expanded', 'true');
        };
        control.addEventListener('click', open);
        control.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
        list.addEventListener('click', event => {
          const option = event.target.closest('[data-value]');
          if (!option) return;
          const value = option.getAttribute('value') || option.dataset.value;
          control.setAttribute('value', value);
          control.setAttribute('aria-valuetext', option.textContent.trim());
          control.setAttribute('aria-expanded', 'false');
          list.hidden = true;
          list.querySelectorAll('[aria-selected]').forEach(candidate => {
            candidate.setAttribute('aria-selected', String(candidate === option));
          });
          result.textContent = 'Current status: ' + option.textContent.trim();
        });
      })();
    </script>`,
  );
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const renderPostback = (seed: string): string => {
  const generatedId = `ctl00_MainContent_${seed}_${postbackRender}_CustomerStatus`;
  return html(
    `<form method="post">
      <input type="hidden" name="__VIEWSTATE" value="opaque-${postbackRender}">
      <input type="hidden" name="__EVENTVALIDATION" value="opaque-${postbackRender}">
      <label for="${generatedId}">Customer Status</label>
      <select
        id="${generatedId}"
        name="ctl00$MainContent$CustomerStatus"
        onchange="this.form.submit()"
      >
        ${STATUS_OPTIONS.map(
          ({ label, value }) =>
            `<option value="${value}" ${
              value === postbackStatus ? 'selected' : ''
            }>${label}</option>`,
        ).join('')}
      </select>
    </form>`,
  ).replace(
    'Current status: Prospect',
    `Current status: ${
      STATUS_OPTIONS.find(({ value }) => value === postbackStatus)?.label ??
      postbackStatus
    }`,
  );
};

beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (
        requestUrl.pathname ===
        '/representation-equivalence/customer-status'
      ) {
        const implementation = requestUrl.searchParams.get(
          'implementation',
        ) as Implementation | null;
        const seed = requestUrl.searchParams.get('seed') ?? 'alpha';
        if (!implementation || !IMPLEMENTATIONS.includes(implementation)) {
          response.writeHead(400, {
            'content-type': 'text/plain; charset=utf-8',
          });
          response.end('Unknown implementation');
          return;
        }
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(renderFixture(implementation, seed));
        return;
      }

      if (
        requestUrl.pathname ===
        '/representation-equivalence/customer-status/postback'
      ) {
        const seed = requestUrl.searchParams.get('seed') ?? 'alpha';
        if (request.method === 'POST') {
          const form = new URLSearchParams(await readBody(request));
          postbackStatus =
            requestUrl.searchParams.get('reject') === '1'
              ? 'prospect'
              : (form.get('ctl00$MainContent$CustomerStatus') ??
                'prospect');
          postbackRender += 1;
        } else {
          postbackStatus = 'prospect';
          postbackRender += 1;
        }
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(renderPostback(seed));
        return;
      }

      if (
        requestUrl.pathname ===
        '/representation-equivalence/iframe-host'
      ) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(`<!doctype html>
          <title>Embedded editor host</title>
          <iframe
            title="Embedded customer editor"
            src="/representation-equivalence/iframe-child"
            style="width: 600px; height: 240px"
          ></iframe>`);
        return;
      }

      if (
        requestUrl.pathname ===
        '/representation-equivalence/editable-combobox'
      ) {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(`<!doctype html>
          <title>Editable customer search</title>
          <label for="customer-search">Customer search</label>
          <input
            id="customer-search"
            role="combobox"
            aria-controls="customer-suggestions"
            aria-expanded="false"
          >
          <div id="customer-suggestions" role="listbox" hidden></div>
          <script>
            const control = document.querySelector('#customer-search');
            const list = document.querySelector('#customer-suggestions');
            let timer;
            control.addEventListener('input', () => {
              clearTimeout(timer);
              list.hidden = true;
              list.replaceChildren();
              control.setAttribute('aria-expanded', 'false');
              timer = setTimeout(() => {
                list.innerHTML =
                  '<div role="option" value="active" aria-selected="false">Active</div>' +
                  '<div role="option" value="prospect" aria-selected="false">Prospect</div>';
              }, 75);
            });
            control.addEventListener('click', () => {
              if (list.children.length > 0) {
                list.hidden = false;
                control.setAttribute('aria-expanded', 'true');
              }
            });
            list.addEventListener('click', event => {
              const option = event.target.closest('[role="option"]');
              if (!option) return;
              control.value = option.getAttribute('value');
              control.setAttribute('aria-valuetext', option.textContent.trim());
              control.setAttribute('aria-expanded', 'false');
              list.hidden = true;
              list.querySelectorAll('[role="option"]').forEach(candidate => {
                candidate.setAttribute('aria-selected', String(candidate === option));
              });
            });
          </script>`);
        return;
      }

      if (
        requestUrl.pathname ===
        '/representation-equivalence/iframe-child'
      ) {
        if (request.method === 'POST') await readBody(request);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(`<!doctype html>
          <title>Embedded customer editor</title>
          <form method="post">
            <button type="submit">Refresh embedded editor</button>
          </form>`);
        return;
      }

      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Not found');
    } catch (error) {
      response.writeHead(500, {
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

const withRuntime = async <T>(
  run: (
    runtime: BrowserIRRuntime,
    browserId: string,
  ) => Promise<T>,
): Promise<T> => {
  const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
  const created = await runtime.create();
  try {
    return await run(runtime, created.browserId);
  } finally {
    await runtime.close({ browserId: created.browserId });
  }
};

const navigate = async (
  runtime: BrowserIRRuntime,
  browserId: string,
  url: string,
  expectedRevision = 0,
): Promise<ObservationResult> =>
  runtime.navigate({
    browserId,
    expectedRevision,
    url,
    budget: { maxCharacters: 12_000 },
  });

const statusEntity = (view: CompiledView) => {
  const matches = view.structured.entities.filter(
    (entity) => entity.name === 'Customer Status',
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one Customer Status entity, received ${matches.length}`,
    );
  }
  return matches[0]!;
};

const expectConforming = (
  view: CompiledView,
  selectedValue: string,
  context: string,
): {
  normalized: NormalizedRepresentation;
  representationCharacters: number;
} => {
  const grade = gradeRepresentation(
    view,
    customerStatusContract(selectedValue),
  );
  expect.soft(grade.violations, context).toEqual([]);
  expect.soft(grade.scores, context).toEqual({
    coverage: 1,
    semantics: 1,
    relationRecall: 1,
    actionablePrecision: 1,
    compactness: 1,
  });
  expect.soft(grade.passed, context).toBe(true);
  return {
    normalized: grade.normalized,
    representationCharacters: grade.metrics.representationCharacters,
  };
};

describe('technology-neutral representation conformance', () => {
  it('emits the same semantic IR across native, ARIA, roleless, and Shadow DOM choices', async () => {
    let reference: NormalizedRepresentation | undefined;
    const representationCharacters: number[] = [];

    for (const seed of SEEDS) {
      for (const implementation of IMPLEMENTATIONS) {
        const conformance = await withRuntime(
          async (runtime, browserId) => {
            const result = await navigate(
              runtime,
              browserId,
              `${origin}/representation-equivalence/customer-status?implementation=${implementation}&seed=${seed}`,
            );
            return expectConforming(
              result.view,
              'prospect',
              `${implementation}/${seed}`,
            );
          },
        );
        reference ??= conformance.normalized;
        representationCharacters.push(
          conformance.representationCharacters,
        );
        expect
          .soft(conformance.normalized, `${implementation}/${seed}`)
          .toEqual(reference);
      }
    }
    const smallest = Math.min(...representationCharacters);
    const largest = Math.max(...representationCharacters);
    expect.soft(largest / smallest).toBeLessThanOrEqual(1.5);
  }, 60_000);

  it.each(IMPLEMENTATIONS)(
    'selects an exact option through the same IR action for the %s implementation',
    async (implementation) => {
      await withRuntime(async (runtime, browserId) => {
        const initial = await navigate(
          runtime,
          browserId,
          `${origin}/representation-equivalence/customer-status?implementation=${implementation}&seed=action`,
        );
        expectConforming(initial.view, 'prospect', `${implementation}/before`);
        const target = statusEntity(initial.view);

        const receipt = await runtime.act({
          browserId,
          expectedRevision: initial.view.revision,
          action: {
            kind: 'select',
            target: target.ref,
            values: ['active'],
          },
          budget: { maxCharacters: 12_000 },
        });

        expect.soft(receipt.status).toBe('verified');
        if (!receipt.observation) {
          throw new Error('selection did not produce an observation');
        }
        expectConforming(
          receipt.observation.view,
          'active',
          `${implementation}/after`,
        );
      });
    },
    30_000,
  );

  it('preserves logical identity but advances the document epoch across a same-URL WebForms postback', async () => {
    await withRuntime(async (runtime, browserId) => {
      const url = `${origin}/representation-equivalence/customer-status/postback?seed=postback`;
      const initial = await navigate(runtime, browserId, url);
      expectConforming(initial.view, 'prospect', 'postback/before');
      const before = statusEntity(initial.view);

      const receipt = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: {
          kind: 'select',
          target: before.ref,
          values: ['active'],
        },
        budget: { maxCharacters: 12_000 },
      });

      expect.soft(receipt.status).toBe('verified');
      if (!receipt.observation) {
        throw new Error('postback selection did not produce an observation');
      }
      expectConforming(receipt.observation.view, 'active', 'postback/after');
      const after = statusEntity(receipt.observation.view);
      expect.soft(after.ref.entityId).toBe(before.ref.entityId);
      expect.soft(after.ref.revision).toBeGreaterThan(before.ref.revision);
      expect.soft(receipt.delta?.pageChanged).toBe(true);
      expect.soft(receipt.delta?.invalidatedRefs).toContain(before.ref.entityId);

      const stale = await runtime.act({
        browserId,
        expectedRevision: receipt.observation.view.revision,
        action: {
          kind: 'select',
          target: before.ref,
          values: ['suspended'],
        },
      });
      expect(stale.status).toBe('stale_target');
      expect(stale.dispatched).toBe(false);
    });
  }, 30_000);

  it('advances revision for an identical full-document replacement without changing logical identity', async () => {
    await withRuntime(async (runtime, browserId) => {
      const url = `${origin}/representation-equivalence/customer-status/postback?seed=identical`;
      const first = await navigate(runtime, browserId, url);
      const before = statusEntity(first.view);

      const second = await navigate(
        runtime,
        browserId,
        url,
        first.view.revision,
      );
      const after = statusEntity(second.view);

      expectConforming(second.view, 'prospect', 'identical replacement');
      expect.soft(after.ref.entityId).toBe(before.ref.entityId);
      expect.soft(second.view.revision).toBeGreaterThan(first.view.revision);
      expect.soft(second.delta.pageChanged).toBe(true);
      expect.soft(second.delta.added).toEqual([]);
      expect.soft(second.delta.removed).toEqual([]);
      expect.soft(second.delta.changed).toEqual([]);
      expect.soft(second.delta.invalidatedRefs).toContain(before.ref.entityId);
    });
  }, 30_000);

  it('keeps document identity but invalidates revision-bound refs after fragment navigation', async () => {
    await withRuntime(async (runtime, browserId) => {
      const url = `${origin}/representation-equivalence/customer-status?implementation=native&seed=fragment`;
      const first = await navigate(runtime, browserId, url);
      const before = statusEntity(first.view);
      const link = first.view.structured.entities.find(
        (entity) => entity.name === 'Open details',
      );
      if (!link) throw new Error('missing fragment navigation link');
      const receipt = await runtime.act({
        browserId,
        expectedRevision: first.view.revision,
        action: { kind: 'click', target: link.ref },
        budget: { maxCharacters: 12_000 },
      });
      if (!receipt.observation) {
        throw new Error('fragment navigation did not produce an observation');
      }
      const second = receipt.observation;
      const after = statusEntity(second.view);

      expectConforming(second.view, 'prospect', 'fragment navigation');
      expect.soft(after.ref.entityId).toBe(before.ref.entityId);
      expect.soft(second.delta.pageChanged).toBe(true);
      expect.soft(second.delta.invalidatedRefs).toContain(
        before.ref.entityId,
      );
    });
  }, 30_000);

  it('does not mistake a rejected full postback for a successful selection', async () => {
    await withRuntime(async (runtime, browserId) => {
      const url = `${origin}/representation-equivalence/customer-status/postback?seed=rejected&reject=1`;
      const initial = await navigate(runtime, browserId, url);
      const before = statusEntity(initial.view);

      const receipt = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: {
          kind: 'select',
          target: before.ref,
          values: ['active'],
        },
        budget: { maxCharacters: 12_000 },
      });

      expect.soft(receipt.status).toBe('dispatched_unverified');
      expect.soft(receipt.dispatched).toBe(true);
      if (!receipt.observation) {
        throw new Error('rejected postback did not produce an observation');
      }
      expectConforming(
        receipt.observation.view,
        'prospect',
        'rejected postback',
      );
      const after = statusEntity(receipt.observation.view);
      expect.soft(after.ref.entityId).toBe(before.ref.entityId);
      expect.soft(after.ref.revision).toBeGreaterThan(before.ref.revision);
      expect.soft(receipt.delta?.pageChanged).toBe(true);
      expect.soft(receipt.effects).toContainEqual(
        expect.objectContaining({
          kind: 'graph_changed',
          verified: false,
        }),
      );
    });
  }, 30_000);

  it('refuses an exact custom option that is semantically disabled before opening the control', async () => {
    await withRuntime(async (runtime, browserId) => {
      const initial = await navigate(
        runtime,
        browserId,
        `${origin}/representation-equivalence/customer-status?implementation=aria&seed=disabled`,
      );
      const target = statusEntity(initial.view);
      const disabledOption = initial.view.structured.entities.find(
        (entity) => entity.name === 'Active',
      );
      expect.soft(disabledOption?.state.enabled).toBe(false);

      const receipt = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: {
          kind: 'select',
          target: target.ref,
          values: ['active'],
        },
      });

      expect.soft(receipt.status).toBe('blocked');
      expect.soft(receipt.dispatched).toBe(false);
      const after = await runtime.observe({ browserId });
      expect.soft(statusEntity(after.view).state.expanded).toBe(false);
    });
  }, 30_000);

  it('reports partial custom-choice dispatch when an exact option disappears during opening', async () => {
    await withRuntime(async (runtime, browserId) => {
      const initial = await navigate(
        runtime,
        browserId,
        `${origin}/representation-equivalence/customer-status?implementation=aria&seed=vanishing`,
      );
      const target = statusEntity(initial.view);

      const receipt = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: {
          kind: 'select',
          target: target.ref,
          values: ['active'],
        },
      });

      expect.soft(receipt.status).toBe('dispatched_unverified');
      expect.soft(receipt.dispatched).toBe(true);
      expect.soft(receipt.observation).toBeDefined();
      expect.soft(
        receipt.observation?.view.structured.entities.some(
          (entity) => entity.name === 'Active',
        ),
      ).toBe(false);
    });
  }, 30_000);

  it('keeps text-entry actions on an editable combobox and observes delayed options', async () => {
    await withRuntime(async (runtime, browserId) => {
      const initial = await navigate(
        runtime,
        browserId,
        `${origin}/representation-equivalence/editable-combobox`,
      );
      const control = initial.view.structured.entities.find(
        (entity) => entity.name === 'Customer search',
      );
      if (!control) throw new Error('missing editable combobox');
      expect.soft(control.capabilities.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining(['fill', 'type', 'press', 'select']),
      );
      expect.soft(
        initial.view.structured.entities.filter(
          (entity) => entity.kind === 'option',
        ),
      ).toEqual([]);

      const filled = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: {
          kind: 'fill',
          target: control.ref,
          value: 'act',
        },
        budget: { maxCharacters: 12_000 },
      });
      expect.soft(filled.status).toBe('verified');
      if (!filled.observation) {
        throw new Error('editable fill did not produce an observation');
      }

      const materialized = await runtime.wait({
        browserId,
        expectedRevision: filled.observation.view.revision,
        condition: {
          kind: 'entity_present',
          role: 'option',
          name: 'Active',
        },
        timeoutMs: 2_000,
        pollIntervalMs: 20,
        budget: { maxCharacters: 12_000 },
      });
      const refreshedControl = materialized.view.structured.entities.find(
        (entity) => entity.name === 'Customer search',
      );
      if (!refreshedControl) {
        throw new Error('missing refreshed editable combobox');
      }
      const active = materialized.view.structured.entities.find(
        (entity) => entity.name === 'Active',
      );
      if (!active) throw new Error('missing delayed Active option');
      expect.soft(
        materialized.view.structured.relations.some(
          (relation) =>
            relation.kind === 'option-of' &&
            relation.from.entityId === active.ref.entityId &&
            relation.to.entityId === refreshedControl.ref.entityId,
        ),
      ).toBe(true);

      const selected = await runtime.act({
        browserId,
        expectedRevision: materialized.view.revision,
        action: {
          kind: 'select',
          target: refreshedControl.ref,
          values: ['active'],
        },
      });
      expect.soft(selected.status).toBe('verified');
      expect.soft(
        selected.observation?.view.structured.entities.find(
          (entity) => entity.name === 'Customer search',
        )?.value,
      ).toBe('active');
    });
  }, 30_000);

  it('advances revision without treating child-document replacement alone as click verification', async () => {
    await withRuntime(async (runtime, browserId) => {
      const initial = await navigate(
        runtime,
        browserId,
        `${origin}/representation-equivalence/iframe-host`,
      );
      const before = initial.view.structured.entities.find(
        (entity) => entity.name === 'Refresh embedded editor',
      );
      if (!before) throw new Error('missing embedded refresh action');

      const receipt = await runtime.act({
        browserId,
        expectedRevision: initial.view.revision,
        action: { kind: 'click', target: before.ref },
        budget: { maxCharacters: 12_000 },
      });

      expect.soft(receipt.status).toBe('dispatched_unverified');
      if (!receipt.observation) {
        throw new Error('embedded postback did not produce an observation');
      }
      const after = receipt.observation.view.structured.entities.find(
        (entity) => entity.name === 'Refresh embedded editor',
      );
      if (!after) throw new Error('missing refreshed embedded action');
      expect.soft(after.ref.entityId).toBe(before.ref.entityId);
      expect.soft(after.ref.revision).toBeGreaterThan(before.ref.revision);
      expect.soft(receipt.delta?.pageChanged).toBe(true);
      expect.soft(receipt.delta?.invalidatedRefs).toContain(
        before.ref.entityId,
      );
    });
  }, 30_000);
});
