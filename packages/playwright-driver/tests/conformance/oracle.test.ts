import type { CompiledView } from '@browserir/core';
import { describe, expect, it } from 'vitest';

import {
  gradeRepresentation,
  type RepresentationContract,
} from './oracle.js';

const view = (overrides: Partial<CompiledView> = {}): CompiledView => ({
  browserId: 'browser-1',
  pageId: 'page-1',
  revision: 7,
  text: '[e99@r7] Customer Status\n[e100@r7] Active',
  truncated: false,
  structured: {
    page: { url: 'https://fixture.test/' },
    entities: [
      {
        kind: 'input',
        role: 'combobox',
        name: 'Customer   Status',
        value: 'prospect',
        state: { visible: true, enabled: true, expanded: false },
        capabilities: [
          { kind: 'focus', enabled: true },
          { kind: 'select', enabled: true },
        ],
        ref: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e99',
          revision: 7,
        },
      },
      {
        kind: 'option',
        role: 'option',
        name: 'Active',
        value: 'active',
        state: { visible: false, enabled: true, selected: false },
        capabilities: [],
        ref: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e100',
          revision: 7,
        },
      },
    ],
    relations: [
      {
        from: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e100',
          revision: 7,
        },
        to: {
          browserId: 'browser-1',
          pageId: 'page-1',
          entityId: 'e99',
          revision: 7,
        },
        kind: 'option-of',
      },
    ],
    omissions: [],
  },
  ...overrides,
});

const contract: RepresentationContract = {
  id: 'customer-status/v1',
  requireTextParity: true,
  required: [
    {
      key: 'status',
      locate: { name: 'Customer Status' },
      expect: {
        kind: 'input',
        role: 'combobox',
        name: 'Customer Status',
        value: 'prospect',
        state: { visible: true, enabled: true, expanded: false },
        actions: ['focus', 'select'],
      },
    },
    {
      key: 'active-option',
      locate: { kind: 'option', name: 'Active' },
      expect: {
        kind: 'option',
        role: 'option',
        name: 'Active',
        value: 'active',
        state: { enabled: true, selected: false },
        actions: [],
      },
    },
  ],
  relations: [
    { from: 'active-option', kind: 'option-of', to: 'status' },
  ],
  allowedActionables: [{ name: 'Customer Status' }],
  budget: { maxCharacters: 4_000, maxUnexpectedActionables: 0 },
};

describe('representation conformance oracle', () => {
  it('grades the public model view and normalizes away runtime identity', () => {
    const grade = gradeRepresentation(view(), contract);

    expect(grade.passed).toBe(true);
    expect(grade.scores).toEqual({
      coverage: 1,
      semantics: 1,
      relationRecall: 1,
      actionablePrecision: 1,
      compactness: 1,
    });
    expect(grade.normalized).toEqual({
      units: [
        {
          key: 'active-option',
          kind: 'option',
          role: 'option',
          name: 'Active',
          value: 'active',
          state: { enabled: true, selected: false, visible: false },
          actions: [],
        },
        {
          key: 'status',
          kind: 'input',
          role: 'combobox',
          name: 'Customer Status',
          value: 'prospect',
          state: { enabled: true, expanded: false, visible: true },
          actions: ['focus', 'select'],
        },
      ],
      relations: [
        { from: 'active-option', kind: 'option-of', to: 'status' },
      ],
    });
    expect(JSON.stringify(grade.normalized)).not.toContain('e99');
    expect(JSON.stringify(grade.normalized)).not.toContain('revision');
  });

  it('reports missing, ambiguous, forbidden, unexpected and over-budget facts separately', () => {
    const broken = view({
      text: 'x'.repeat(4_000),
      structured: {
        ...view().structured,
        entities: [
          ...view().structured.entities,
          {
            ...view().structured.entities[0]!,
            name: 'Customer Status',
            ref: {
              ...view().structured.entities[0]!.ref,
              entityId: 'e101',
            },
          },
          {
            ...view().structured.entities[0]!,
            name: '__VIEWSTATE',
            ref: {
              ...view().structured.entities[0]!.ref,
              entityId: 'e102',
            },
          },
        ],
      },
    });
    const grade = gradeRepresentation(broken, {
      ...contract,
      required: [
        contract.required[0]!,
        {
          key: 'suspended-option',
          locate: { kind: 'option', name: 'Suspended' },
          expect: { kind: 'option', name: 'Suspended' },
        },
      ],
      forbidden: [
        { label: 'postback infrastructure', match: { name: '__VIEWSTATE' } },
      ],
      budget: { maxCharacters: 1_000, maxUnexpectedActionables: 0 },
    });

    expect(grade.passed).toBe(false);
    expect(new Set(grade.violations.map((violation) => violation.kind))).toEqual(
      new Set([
        'ambiguous',
        'missing',
        'forbidden',
        'relation',
        'unexpected_actionable',
        'budget',
      ]),
    );
  });

  it('retains unasserted semantic fields and rejects action-set or text-channel drift', () => {
    const changed = view({
      structured: {
        ...view().structured,
        entities: [
          {
            ...view().structured.entities[0]!,
            state: {
              ...view().structured.entities[0]!.state,
              busy: true,
            },
            capabilities: [
              ...view().structured.entities[0]!.capabilities,
              { kind: 'hover', enabled: true },
            ],
          },
          view().structured.entities[1]!,
        ],
      },
      text: 'Customer Status without a revision-bound reference',
    });

    const grade = gradeRepresentation(changed, contract);
    const status = grade.normalized.units.find((unit) => unit.key === 'status');

    expect(grade.passed).toBe(false);
    expect(grade.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'semantic', key: 'status' }),
        expect.objectContaining({ kind: 'text', key: 'status' }),
      ]),
    );
    expect(status?.state).toMatchObject({ busy: true });
    expect(status?.actions).toEqual(['focus', 'hover', 'select']);
  });
});
