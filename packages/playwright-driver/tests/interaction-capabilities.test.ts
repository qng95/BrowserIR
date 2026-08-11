import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import {
  BrowserIRRuntime,
  type Capability,
  type CompiledEntity,
  type CompiledView,
} from '@browserir/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPlaywrightBrowserDriver } from '../src/index.js';

let server: Server;
let origin: string;

const fixture = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Interaction capability laboratory</title>
    <style>
      body { font: 16px sans-serif; padding: 24px; }
      [role="grid"] { display: grid; gap: 8px; margin-bottom: 24px; }
      [role="row"] { display: flex; gap: 8px; }
      [role="gridcell"], .appointment, .drop-zone {
        border: 1px solid #777;
        box-sizing: border-box;
        min-height: 44px;
        min-width: 150px;
        padding: 10px;
      }
      .occlusion-shell { height: 44px; position: relative; width: 150px; }
      .occlusion-shell [role="gridcell"], .cover { inset: 0; position: absolute; }
      .cover { background: #fff; z-index: 2; }
      .drag-layout { display: flex; gap: 16px; }
      .choice-layout, [role="menu"] { margin-top: 24px; }
      [role="option"], [role^="menuitem"] {
        border: 1px solid #777;
        box-sizing: border-box;
        min-height: 36px;
        padding: 8px;
        width: 220px;
      }
      [role="combobox"] { min-height: 36px; width: 220px; }
    </style>
  </head>
  <body>
    <main aria-label="Interaction laboratory">
      <div role="grid" aria-label="Editable records">
        <div role="row">
          <div id="tracked-edit" role="gridcell">Tracked edit</div>
          <div id="inline-edit" role="gridcell"
            ondblclick="this.textContent = 'Inline edit complete'">Inline edit</div>
          <div id="click-only" role="gridcell">Click only</div>
          <div role="gridcell">Plain cell</div>
        </div>
        <div role="row">
          <div id="disabled-edit" role="gridcell" aria-disabled="true">Disabled edit</div>
          <div id="hidden-edit" role="gridcell" hidden>Hidden edit</div>
          <div class="occlusion-shell">
            <div id="occluded-edit" role="gridcell">Occluded edit</div>
            <div class="cover">Cover</div>
          </div>
        </div>
      </div>
      <div id="delegated-grid" role="grid" aria-label="Delegated editable records">
        <div role="row">
          <div role="gridcell" tabindex="0">Delegated edit</div>
          <div role="gridcell">Delegated plain cell</div>
        </div>
      </div>

      <div class="drag-layout">
        <div id="native-appointment" class="appointment" draggable="true"
          aria-label="Appointment 42">Appointment 42</div>
        <div id="aria-appointment" class="appointment" aria-grabbed="false"
          aria-label="Appointment 77">Appointment 77</div>
        <div id="disabled-appointment" class="appointment" draggable="true"
          aria-disabled="true" aria-label="Disabled appointment">Disabled appointment</div>
        <div id="hidden-appointment" class="appointment" draggable="true"
          aria-label="Hidden appointment" hidden>Hidden appointment</div>
        <div id="archive-lane" class="drop-zone" aria-label="Archive lane">Archive lane</div>
      </div>

      <div class="choice-layout">
        <div id="priority-picker" role="combobox" aria-label="Priority"
          aria-controls="priority-options" aria-expanded="true" tabindex="0"></div>
        <div id="priority-options" role="listbox">
          <div id="urgent-option" role="option" tabindex="-1" data-id="urgent"
            aria-selected="false">Urgent</div>
          <div role="option" tabindex="-1" data-id="disabled-priority"
            aria-disabled="true">Disabled priority</div>
          <div role="option" tabindex="-1" data-id="hidden-priority"
            hidden>Hidden priority</div>
          <div class="occlusion-shell">
            <div role="option" tabindex="-1" data-id="occluded-priority">
              Occluded priority
            </div>
            <div class="cover">Option cover</div>
          </div>
        </div>
        <select aria-label="Native priority">
          <option value="native">Native priority option</option>
        </select>
        <div id="vehicle-results" role="listbox" aria-label="Vehicle results">
          <div id="vehicle-option" role="option" tabindex="-1" data-id="vehicle-146">
            <strong>Mercedes-Benz Sprinter</strong> 2.2 HDi
            <span>WV1ZZZ0000146 · In stock · 14.550 €</span>
          </div>
          <div role="option" tabindex="-1" data-id="vehicle-disabled" aria-disabled="true">
            Disabled vehicle WV1ZZZ0000998
          </div>
          <div role="option" tabindex="-1" data-id="vehicle-hidden" hidden>
            Hidden vehicle WV1ZZZ0000999
          </div>
        </div>
      </div>

      <button id="order-context" aria-haspopup="menu" aria-expanded="false">Order 1001</button>
      <div id="menu-host"></div>
    </main>
    <script>
      const tracked = document.querySelector('#tracked-edit');
      tracked.addEventListener('dblclick', () => {
        tracked.textContent = 'Tracked edit complete';
      });
      document.querySelector('#inline-edit').addEventListener('click', () => {});
      document.querySelector('#click-only').addEventListener('click', () => {});
      document.querySelector('#disabled-edit').addEventListener('dblclick', () => {});
      document.querySelector('#hidden-edit').addEventListener('dblclick', () => {});
      document.querySelector('#occluded-edit').addEventListener('dblclick', () => {});
      document.querySelector('#delegated-grid').addEventListener('dblclick', event => {
        const target = event.target.closest('[role="gridcell"][tabindex]');
        if (target) target.textContent = 'Delegated edit complete';
      });

      const source = document.querySelector('#native-appointment');
      const archive = document.querySelector('#archive-lane');
      source.addEventListener('dragstart', event => {
        event.dataTransfer?.setData('text/plain', source.textContent.trim());
      });
      archive.addEventListener('dragover', event => event.preventDefault());
      archive.addEventListener('drop', event => {
        event.preventDefault();
        archive.textContent = 'Archived ' +
          (event.dataTransfer?.getData('text/plain') || source.textContent.trim());
      });

      const urgent = document.querySelector('#urgent-option');
      urgent.addEventListener('click', () => {
        urgent.setAttribute('aria-selected', 'true');
        urgent.textContent = 'Urgent selected';
      });
      document.querySelector('#vehicle-results').addEventListener('click', event => {
        const option = event.target.closest('[role="option"]');
        if (option && option.getAttribute('aria-disabled') !== 'true') {
          option.setAttribute('aria-selected', 'true');
        }
      });

      document.querySelector('#order-context').addEventListener('contextmenu', event => {
        event.preventDefault();
        event.currentTarget.setAttribute('aria-expanded', 'true');
        const host = document.querySelector('#menu-host');
        host.innerHTML = [
          '<div role="menu" aria-label="Order actions">',
          '  <div id="deliver-item" role="menuitem" tabindex="-1">Mark delivered</div>',
          '  <div role="menuitemcheckbox" tabindex="-1" aria-checked="false">Include invoice</div>',
          '  <div role="menuitemradio" tabindex="-1" aria-checked="false">Email receipt</div>',
          '  <div role="menuitem" tabindex="-1" aria-disabled="true">Disabled order action</div>',
          '  <div role="menuitem" tabindex="-1" hidden>Hidden order action</div>',
          '  <div inert><div role="menuitem" tabindex="-1">Inert order action</div></div>',
          '  <div class="occlusion-shell">',
          '    <div role="menuitem" tabindex="-1">Occluded order action</div>',
          '    <div class="cover">Menu cover</div>',
          '  </div>',
          '</div>',
        ].join('');
        document.querySelector('#deliver-item').addEventListener('click', event => {
          event.currentTarget.textContent = 'Order delivered';
        });
      });
    </script>
  </body>
</html>`;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Interaction fixture did not bind a TCP port.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
});

const unique = (
  view: CompiledView,
  predicate: (entity: CompiledEntity) => boolean,
  description: string,
): CompiledEntity => {
  const matches = view.structured.entities.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}, received ${matches.length}.`);
  }
  return matches[0]!;
};

const named = (view: CompiledView, name: string): CompiledEntity =>
  unique(view, (entity) => entity.name === name, name);

const cell = (view: CompiledView, text: string): CompiledEntity =>
  unique(
    view,
    (entity) => entity.kind === 'cell' && entity.text === text,
    `${text} cell`,
  );

const enabledKinds = (entity: CompiledEntity): string[] =>
  entity.capabilities
    .filter((capability) => capability.enabled !== false)
    .map((capability) => capability.kind)
    .sort();

const capability = (
  entity: CompiledEntity,
  kind: Capability['kind'],
): Capability | undefined =>
  entity.capabilities.find((candidate) => candidate.kind === kind);

describe('evidence-backed double-click and drag capabilities', () => {
  it('infers only behavior supported by native, ARIA, or listener evidence', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 50_000 },
      });
      const tracked = cell(observed.view, 'Tracked edit');
      const inline = cell(observed.view, 'Inline edit');
      const clickOnly = cell(observed.view, 'Click only');
      const plain = cell(observed.view, 'Plain cell');
      const disabled = cell(observed.view, 'Disabled edit');
      const occluded = cell(observed.view, 'Occluded edit');
      const delegated = cell(observed.view, 'Delegated edit');
      const delegatedPlain = cell(observed.view, 'Delegated plain cell');

      expect.soft(enabledKinds(tracked)).toEqual(['doubleClick']);
      expect.soft(enabledKinds(inline)).toEqual(['click', 'doubleClick']);
      expect.soft(enabledKinds(clickOnly)).toEqual(['click']);
      expect.soft(enabledKinds(plain)).toEqual([]);
      expect.soft(capability(disabled, 'doubleClick')).toMatchObject({
        kind: 'doubleClick',
        enabled: false,
      });
      expect.soft(enabledKinds(occluded)).not.toContain('doubleClick');
      expect.soft(enabledKinds(delegated)).toContain('doubleClick');
      expect.soft(enabledKinds(delegatedPlain)).not.toContain('doubleClick');
      expect.soft(
        observed.view.structured.entities.some(
          (entity) => entity.text === 'Hidden edit',
        ),
      ).toBe(false);

      const nativeSource = named(observed.view, 'Appointment 42');
      const ariaSource = named(observed.view, 'Appointment 77');
      const disabledSource = named(observed.view, 'Disabled appointment');
      const dropTarget = named(observed.view, 'Archive lane');
      expect.soft(nativeSource.role).toBeUndefined();
      expect.soft(ariaSource.role).toBeUndefined();
      expect.soft(dropTarget.role).toBeUndefined();
      expect.soft(enabledKinds(nativeSource)).toContain('drag');
      expect.soft(enabledKinds(ariaSource)).toContain('drag');
      expect.soft(capability(disabledSource, 'drag')).toMatchObject({
        kind: 'drag',
        enabled: false,
      });
      expect.soft(enabledKinds(dropTarget)).not.toContain('drag');
      expect.soft(enabledKinds(dropTarget)).not.toContain('click');
      expect.soft(enabledKinds(dropTarget)).not.toContain('doubleClick');
      expect.soft(
        observed.view.structured.entities.some(
          (entity) => entity.name === 'Hidden appointment',
        ),
      ).toBe(false);

      const evidence = await runtime.inspect({
        browserId: created.browserId,
        includeEvidence: true,
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(
        unique(
          evidence,
          (entity) => entity.ref.entityId === tracked.ref.entityId,
          'inspected tracked cell',
        ).evidence,
      ).toContainEqual(
        expect.objectContaining({
          sensor: 'playwright-dom-interaction',
          detail: 'dom-double-click-listener',
        }),
      );
      expect.soft(
        unique(
          evidence,
          (entity) => entity.ref.entityId === nativeSource.ref.entityId,
          'inspected native drag source',
        ).evidence,
      ).toContainEqual(
        expect.objectContaining({
          sensor: 'playwright-dom-interaction',
          detail: 'native-draggable',
        }),
      );
      expect.soft(
        unique(
          evidence,
          (entity) => entity.ref.entityId === dropTarget.ref.entityId,
          'inspected drop target',
        ).evidence,
      ).toContainEqual(
        expect.objectContaining({
          sensor: 'playwright-dom-interaction',
          detail: 'dom-drop-listener',
        }),
      );
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  }, 30_000);

  it('dispatches and verifies double-click and drag through canonical refs', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      let current = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 50_000 },
      });
      const tracked = cell(current.view, 'Tracked edit');
      const doubleReceipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: current.view.revision,
        action: { kind: 'doubleClick', target: tracked.ref },
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(doubleReceipt).toMatchObject({
        status: 'verified',
        dispatched: true,
      });
      current =
        doubleReceipt.observation ??
        (await runtime.observe({ browserId: created.browserId }));
      expect.soft(cell(current.view, 'Tracked edit complete')).toBeDefined();

      const delegated = cell(current.view, 'Delegated edit');
      const delegatedReceipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: current.view.revision,
        action: { kind: 'doubleClick', target: delegated.ref },
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(delegatedReceipt).toMatchObject({
        status: 'verified',
        dispatched: true,
      });
      current =
        delegatedReceipt.observation ??
        (await runtime.observe({ browserId: created.browserId }));
      expect.soft(cell(current.view, 'Delegated edit complete')).toBeDefined();

      const source = named(current.view, 'Appointment 42');
      const destination = named(current.view, 'Archive lane');
      expect.soft(enabledKinds(source)).toContain('drag');
      expect.soft(enabledKinds(destination)).not.toContain('drag');
      const dragReceipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: current.view.revision,
        action: {
          kind: 'drag',
          target: source.ref,
          destination: destination.ref,
        },
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(dragReceipt).toMatchObject({
        status: 'verified',
        dispatched: true,
      });
      expect.soft(
        dragReceipt.observation?.view.structured.entities.some(
          (entity) => entity.text?.includes('Archived Appointment 42') === true,
        ),
      ).toBe(true);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  }, 30_000);

  it('activates only visible enabled custom ARIA options', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 50_000 },
      });
      const urgent = named(observed.view, 'Urgent');
      const disabled = named(observed.view, 'Disabled priority');
      const nativeOption = named(observed.view, 'Native priority option');

      expect.soft(urgent).toMatchObject({ kind: 'option', role: 'option' });
      expect.soft(enabledKinds(urgent)).toContain('click');
      expect.soft(capability(disabled, 'click')).toMatchObject({
        kind: 'click',
        enabled: false,
      });
      expect.soft(enabledKinds(nativeOption)).not.toContain('click');
      for (const decoy of ['Hidden priority', 'Occluded priority']) {
        const candidate = observed.view.structured.entities.find(
          (entity) => entity.name === decoy,
        );
        expect.soft(candidate === undefined || !enabledKinds(candidate).includes('click')).toBe(true);
      }

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: observed.view.revision,
        action: { kind: 'click', target: urgent.ref },
        budget: { maxCharacters: 50_000 },
      });
      expect.soft(receipt).toMatchObject({ status: 'verified', dispatched: true });
      expect.soft(named(receipt.observation!.view, 'Urgent selected').state.selected).toBe(true);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  }, 30_000);

  it('keeps a listbox-owned custom option distinct, actionable, and related to its owner', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const observed = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 50_000 },
      });
      const optionName = 'Mercedes-Benz Sprinter 2.2 HDi WV1ZZZ0000146 · In stock · 14.550 €';
      const option = named(observed.view, optionName);
      const owner = named(observed.view, 'Vehicle results');
      const disabled = named(observed.view, 'Disabled vehicle WV1ZZZ0000998');

      expect.soft(option).toMatchObject({ kind: 'option', role: 'option', name: optionName });
      expect.soft(enabledKinds(option)).toContain('click');
      expect.soft(owner).toMatchObject({ role: 'listbox', name: 'Vehicle results' });
      expect.soft(option.ref.entityId).not.toBe(owner.ref.entityId);
      expect.soft(
        observed.view.structured.relations.some(
          (relation) =>
            relation.kind === 'option-of' &&
            relation.from.entityId === option.ref.entityId &&
            relation.to.entityId === owner.ref.entityId,
        ),
      ).toBe(true);
      expect.soft(capability(disabled, 'click')).toMatchObject({
        kind: 'click',
        enabled: false,
      });
      const hidden = observed.view.structured.entities.find(
        (entity) => entity.name === 'Hidden vehicle WV1ZZZ0000999',
      );
      expect.soft(hidden === undefined || !enabledKinds(hidden).includes('click')).toBe(true);
      expect.soft(
        observed.view.structured.entities.filter(
          (entity) => entity.role === 'listbox' && entity.name === optionName,
        ),
      ).toHaveLength(0);
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  }, 30_000);

  it('observes and activates transient ARIA menu items after context click', async () => {
    const runtime = new BrowserIRRuntime(createPlaywrightBrowserDriver());
    const created = await runtime.create();
    try {
      const initial = await runtime.navigate({
        browserId: created.browserId,
        expectedRevision: 0,
        url: origin,
        budget: { maxCharacters: 20_000 },
      });
      const contextTarget = named(initial.view, 'Order 1001');
      const opened = await runtime.act({
        browserId: created.browserId,
        expectedRevision: initial.view.revision,
        action: { kind: 'contextClick', target: contextTarget.ref },
        budget: { maxCharacters: 20_000 },
      });
      expect.soft(opened).toMatchObject({ status: 'verified', dispatched: true });
      const menuView = opened.observation!.view;
      const delivered = unique(
        menuView,
        (entity) => entity.role === 'menuitem' && entity.name === 'Mark delivered',
        'Mark delivered menu item',
      );
      const checkbox = named(menuView, 'Include invoice');
      const radio = named(menuView, 'Email receipt');
      const disabled = named(menuView, 'Disabled order action');

      expect.soft(enabledKinds(delivered)).toContain('click');
      expect.soft(checkbox.role).toBe('menuitemcheckbox');
      expect.soft(enabledKinds(checkbox)).toContain('click');
      expect.soft(radio.role).toBe('menuitemradio');
      expect.soft(enabledKinds(radio)).toContain('click');
      expect.soft(capability(disabled, 'click')).toMatchObject({
        kind: 'click',
        enabled: false,
      });
      for (const decoy of [
        'Hidden order action',
        'Inert order action',
        'Occluded order action',
      ]) {
        const candidate = menuView.structured.entities.find(
          (entity) => entity.name === decoy,
        );
        expect.soft(candidate === undefined || !enabledKinds(candidate).includes('click')).toBe(true);
      }

      const receipt = await runtime.act({
        browserId: created.browserId,
        expectedRevision: menuView.revision,
        action: { kind: 'click', target: delivered.ref },
        budget: { maxCharacters: 20_000 },
      });
      expect.soft(receipt).toMatchObject({ status: 'verified', dispatched: true });
      expect.soft(named(receipt.observation!.view, 'Order delivered')).toBeDefined();
    } finally {
      await runtime.close({ browserId: created.browserId });
    }
  }, 30_000);
});
