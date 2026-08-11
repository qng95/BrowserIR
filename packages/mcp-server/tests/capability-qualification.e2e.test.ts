import { startAppServer } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  BrowserIrReferenceAgent,
  type QualificationEntity,
} from './task-qualification-harness.js';

const suite = process.env['BROWSERIR_RUN_CAPABILITY_QUALIFICATION'] === '1'
  ? describe.sequential
  : describe.skip;

const one = <T>(values: T[], description: string): T => {
  if (values.length !== 1) throw new Error(`Expected one ${description}; found ${values.length}.`);
  return values[0]!;
};

const inspectReport = async (
  agent: BrowserIrReferenceAgent,
  entity: QualificationEntity,
): Promise<string> => JSON.stringify(
  {
    compact: entity,
    inspected: await agent.inspectEntities([entity.id], true),
  },
  null,
  2,
);

suite('generic enterprise interaction capability qualification', () => {
  it('exposes stock and reorder values after reference-only master-detail navigation', async () => {
    const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 50, vehicles: 50 });
    const agent = await BrowserIrReferenceAgent.start(app.origin, 'browserir-capability-parts');
    try {
      await agent.signIn();
      await agent.navigate('/app/parts');
      const engine = agent.current.entities.find(
        (entity) => `${entity.name ?? ''} ${entity.text ?? ''}`.includes('Engine') && entity.actions.includes('click'),
      );
      if (engine === undefined) {
        throw new Error(JSON.stringify(agent.current.entities.filter(
          (entity) => typeof entity.state.expanded === 'boolean' || `${entity.name ?? ''}`.includes('Engine'),
        ), null, 2));
      }
      await agent.click(engine);
      await agent.click(agent.find({ name: 'Filters', role: 'link' }));
      const sku = agent.current.entities.find(
        (entity) => entity.role === 'link' && /^P-[A-Z0-9-]+$/.test(entity.name ?? ''),
      )?.name;
      if (sku === undefined) throw new Error('No represented part SKU appeared for Filters.');
      const row = agent.rowContaining(sku);
      const stock = one(
        agent.children(row).filter(
          (entity) => entity.kind === 'cell' && /^\d+$/.test(entity.text ?? ''),
        ),
        'represented stock cell',
      );
      await agent.click(agent.find({ name: sku, role: 'link' }));
      const visible = agent.current.visibleText ?? '';
      const reorder = /Reorder level\s+(\d+)/.exec(visible)?.[1];
      expect(Number(stock.text)).toBeGreaterThanOrEqual(0);
      expect(reorder, agent.current.modelText).toMatch(/^\d+$/);
    } finally {
      await agent.close();
      await app.close();
    }
  }, 60_000);

  it('represents a delegated double-click editor on a structural table cell', async () => {
    const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 50, vehicles: 50 });
    const agent = await BrowserIrReferenceAgent.start(app.origin, 'browserir-capability-double-click');
    try {
      await agent.signIn();
      await agent.navigate('/app/tickets');
      const row = agent.rowContaining('T-1005');
      const priority = one(
        await agent.inside(
          row,
          (entity) =>
            entity.kind === 'cell' &&
            ['Low', 'Normal', 'High', 'Urgent'].includes(entity.text ?? entity.name ?? ''),
        ),
        'priority cell in T-1005',
      );
      const report = await inspectReport(agent, priority);
      expect(priority, report).toMatchObject({ kind: 'cell', role: 'cell' });
      expect(priority.actions, report).toContain('doubleClick');
    } finally {
      await agent.close();
      await app.close();
    }
  }, 60_000);

  it('represents the exact draggable appointment and a free drop cell', async () => {
    const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 50, vehicles: 50 });
    const agent = await BrowserIrReferenceAgent.start(app.origin, 'browserir-capability-drag');
    try {
      await agent.signIn();
      await agent.navigate('/app/workshop');
      const bay1 = agent.rowContaining('Bay 1');
      const bay4 = agent.rowContaining('Bay 4');
      const cells = agent.children(bay1).filter(
        (entity) => entity.kind === 'cell' && entity.role === 'cell',
      );
      const geometry = await agent.inspectGeometry(cells.map((entity) => entity.id));
      cells.sort(
        (left, right) =>
          (geometry.get(left.id)?.x ?? Number.MAX_SAFE_INTEGER) -
          (geometry.get(right.id)?.x ?? Number.MAX_SAFE_INTEGER),
      );
      const sourceCell = cells[2];
      if (sourceCell === undefined) throw new Error('The Bay 1 13:00 cell was not represented.');
      const appointment = one(
        await agent.inside(
          sourceCell,
          (entity) => entity.role === 'button' && entity.name !== 'Empty slot',
        ),
        'appointment in Bay 1 at 13:00 on 2026-08-03',
      );
      const freeTarget = one(
        (await agent.inside(
          bay4,
          (entity) => entity.role === 'button' && entity.name === 'Empty slot',
        )).slice(0, 1),
        'free Bay 4 drop cell',
      );
      const report = JSON.stringify({
        appointment: JSON.parse(await inspectReport(agent, appointment)),
        free_target: JSON.parse(await inspectReport(agent, freeTarget)),
      }, null, 2);
      expect(freeTarget, report).toMatchObject({ kind: 'control', role: 'button', name: 'Empty slot' });
      expect(appointment.actions, report).toContain('drag');
    } finally {
      await agent.close();
      await app.close();
    }
  }, 60_000);

  it('represents a dynamically inserted custom option div as clickable', async () => {
    const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 50, vehicles: 50 });
    const agent = await BrowserIrReferenceAgent.start(app.origin, 'browserir-capability-custom-option');
    try {
      await agent.signIn();
      await agent.navigate('/app/orders/new');
      await agent.fill(agent.find({ name: 'Customer', role: 'combobox' }), 'K-100032');
      await agent.waitRevisionChange();
      await agent.waitSettled();
      const option = agent.current.entities.find(
        (entity) => entity.role === 'option' && `${entity.name ?? ''} ${entity.text ?? ''}`.includes('K-100032'),
      );
      if (option === undefined) throw new Error('The K-100032 custom option was not represented.');
      const report = await inspectReport(agent, option);
      expect(option, report).toMatchObject({ kind: 'option', role: 'option' });
      expect(option.actions, report).toContain('click');
    } finally {
      await agent.close();
      await app.close();
    }
  }, 60_000);

  it('represents a transient context-menu item as clickable after right-click', async () => {
    const app = await startAppServer({ apiLatencyMs: 0, pageLatencyMs: 0, customers: 50, vehicles: 50 });
    const agent = await BrowserIrReferenceAgent.start(app.origin, 'browserir-capability-context-menu');
    try {
      await agent.signIn();
      await agent.navigate('/app/orders');
      const row = agent.current.entities.find(
        (entity) => entity.kind === 'row' && /A-2026-\d{4}/.test(`${entity.name ?? ''} ${entity.text ?? ''}`),
      );
      if (row === undefined) throw new Error('No order row was represented.');
      const target = one(
        await agent.inside(
          row,
          (entity) => entity.role === 'checkbox' && entity.actions.includes('contextClick'),
        ),
        'context-clickable checkbox in the first order row',
      );
      await agent.act({ kind: 'context_click', target });
      await agent.waitText('Mark delivered', 3_000);
      const menuItem = agent.current.entities.find(
        (entity) =>
          entity.role === 'menuitem' &&
          `${entity.name ?? ''} ${entity.text ?? ''}`.includes('Mark delivered'),
      );
      const report = JSON.stringify({
        target: JSON.parse(await inspectReport(agent, target)),
        visible_text_contains_menu_item: agent.current.visibleText?.includes('Mark delivered') ?? false,
        menu_items: agent.current.entities.filter((entity) => entity.role === 'menuitem'),
        model_view: agent.current.modelText,
      }, null, 2);
      expect(menuItem, report).toBeDefined();
      expect(menuItem?.actions, report).toContain('click');
    } finally {
      await agent.close();
      await app.close();
    }
  }, 60_000);
});
