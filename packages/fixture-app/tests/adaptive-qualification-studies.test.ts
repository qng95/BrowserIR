import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_QUALIFICATION_STUDIES_VERSION,
  ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS,
  ADAPTIVE_QUALIFICATION_STUDY_FAMILIES,
  ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS,
  adaptiveQualificationStudyCases,
  adaptiveQualificationStudyPage,
  expectedAdaptiveQualificationTarget,
  recordAdaptiveQualificationSelection,
  resolveAdaptiveQualificationStudyBinding,
  verifyAdaptiveQualificationSelection,
  type AdaptiveQualificationStudyBinding,
  type AdaptiveQualificationStudyCaseId,
} from '../src/adaptive-qualification-studies.js';
import { createDb } from '../src/db.js';
import type { PageCtx } from '../src/pages.js';

const stripPlacement = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>/gu, '<style></style>');

const pageFor = (binding: AdaptiveQualificationStudyBinding): string => {
  const db = createDb({ customers: 1, vehicles: 1 });
  const contract = adaptiveQualificationStudyCases[binding.caseId];
  const url = new URL(`http://fixture.invalid${contract.path}`);
  const ctx: PageCtx = {
    db,
    path: url.pathname,
    url,
    user: { username: 'test', display_name: 'Test User' },
  };
  try {
    return adaptiveQualificationStudyPage(ctx, binding);
  } finally {
    db.close();
  }
};

describe('adaptive qualification live-study contracts', () => {
  it('pins the geometry-aligned live-study fixture contract at version 2', () => {
    expect(ADAPTIVE_QUALIFICATION_STUDIES_VERSION)
      .toBe('adaptive-qualification-live-studies/2');
  });

  it('freezes two independent real implementations per family and four worlds per site', () => {
    expect(Object.keys(adaptiveQualificationStudyCases))
      .toEqual(ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS);
    for (const familyId of ADAPTIVE_QUALIFICATION_STUDY_FAMILIES) {
      const cases = Object.values(adaptiveQualificationStudyCases)
        .filter((entry) => entry.familyId === familyId);
      expect(cases).toHaveLength(2);
      expect(new Set(cases.map(({ siteId }) => siteId))).toHaveLength(2);
      expect(new Set(cases.map(({ implementationId }) => implementationId))).toHaveLength(2);
    }
    for (const contract of Object.values(adaptiveQualificationStudyCases)) {
      expect(contract.worldIds).toEqual(ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS);
      expect(contract.path).not.toMatch(/lossy|rescue|world/u);
      expect(contract.selectionPath).toBe(`${contract.path}/select`);
      expect(contract.targetIds).toHaveLength(
        contract.familyId === 'schedule-coordinate' ? 4 : 2,
      );
    }
    expect(new Set(Object.values(adaptiveQualificationStudyCases)
      .flatMap(({ targetIds }) => targetIds)).size).toBe(12);
    expect(new Set(Object.values(adaptiveQualificationStudyCases)
      .map(({ path }) => path)).size).toBe(4);
  });

  it('copies the exact host binding and rejects extra or unknown identity fields', () => {
    const input: AdaptiveQualificationStudyBinding = {
      caseId: 'cross-tree/approval-lanes',
      worldId: 'rescue-b',
    };
    const retained = resolveAdaptiveQualificationStudyBinding(input);
    input.worldId = 'lossy-a';
    expect(retained).toEqual({
      caseId: 'cross-tree/approval-lanes',
      worldId: 'rescue-b',
    });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(() => resolveAdaptiveQualificationStudyBinding({
      caseId: 'cross-tree/approval-lanes',
      worldId: 'rescue-b',
      leakedWorldAlias: 'b',
    } as AdaptiveQualificationStudyBinding)).toThrow(/outside the frozen catalog/u);
  });

  it('keeps lossy twins semantically identical outside CSS and never renders a world ID', () => {
    for (const caseId of ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS) {
      const a = pageFor({ caseId, worldId: 'lossy-a' });
      const b = pageFor({ caseId, worldId: 'lossy-b' });
      expect(stripPlacement(a)).toBe(stripPlacement(b));
      expect(a).not.toBe(b);
      for (const html of [a, b]) {
        for (const worldId of ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS) {
          expect(html).not.toContain(worldId);
        }
      }
    }
  });

  it('renders genuinely distinct site structures rather than relabeled variants', () => {
    expect(pageFor({ caseId: 'schedule/workshop-week-table', worldId: 'lossy-a' }))
      .toContain('<table');
    expect(pageFor({ caseId: 'schedule/dispatch-shift-board', worldId: 'lossy-a' }))
      .toContain('role="grid"');
    expect(pageFor({ caseId: 'cross-tree/case-routing-columns', worldId: 'lossy-a' }))
      .toContain('class="qualification-label-tree"');
    expect(pageFor({ caseId: 'cross-tree/approval-lanes', worldId: 'lossy-a' }))
      .toContain('<dl');
  });

  it('flips the expected opaque target in B while rescue mirrors its lossy twin', () => {
    for (const caseId of ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS) {
      const lossyA = expectedAdaptiveQualificationTarget(caseId, 'lossy-a');
      const lossyB = expectedAdaptiveQualificationTarget(caseId, 'lossy-b');
      expect(lossyA).not.toBe(lossyB);
      expect(expectedAdaptiveQualificationTarget(caseId, 'rescue-a')).toBe(lossyA);
      expect(expectedAdaptiveQualificationTarget(caseId, 'rescue-b')).toBe(lossyB);
    }
  });
});

describe('adaptive qualification host-only one-shot oracle', () => {
  it('passes exactly one correct POST-equivalent selection in every case/world cell', () => {
    for (const caseId of ADAPTIVE_QUALIFICATION_STUDY_CASE_IDS) {
      for (const worldId of ADAPTIVE_QUALIFICATION_STUDY_WORLD_IDS) {
        const db = createDb({ customers: 1, vehicles: 1 });
        const expected = expectedAdaptiveQualificationTarget(caseId, worldId);
        recordAdaptiveQualificationSelection(db, 'test', { caseId, worldId }, expected);
        expect(verifyAdaptiveQualificationSelection(db, { caseId, worldId })).toEqual({
          passed: true,
          outcome: 'passed',
          expectedTargetId: expected,
          selectedTargetIds: [expected],
          mutationCount: 1,
          collateralMutationCount: 0,
          totalStudyMutationCount: 1,
        });
        db.close();
      }
    }
  });

  it('permanently fails wrong-then-correct and any collateral study mutation', () => {
    const caseId: AdaptiveQualificationStudyCaseId = 'schedule/workshop-week-table';
    const worldId = 'lossy-b' as const;
    const contract = adaptiveQualificationStudyCases[caseId];
    const expected = expectedAdaptiveQualificationTarget(caseId, worldId);
    const wrong = contract.targetIds.find((target) => target !== expected)!;

    const repaired = createDb({ customers: 1, vehicles: 1 });
    recordAdaptiveQualificationSelection(repaired, 'test', { caseId, worldId }, wrong);
    recordAdaptiveQualificationSelection(repaired, 'test', { caseId, worldId }, expected);
    expect(verifyAdaptiveQualificationSelection(repaired, { caseId, worldId })).toMatchObject({
      passed: false,
      mutationCount: 2,
      collateralMutationCount: 0,
      totalStudyMutationCount: 2,
      selectedTargetIds: [wrong, expected],
    });
    repaired.close();

    const collateral = createDb({ customers: 1, vehicles: 1 });
    recordAdaptiveQualificationSelection(collateral, 'test', { caseId, worldId }, expected);
    recordAdaptiveQualificationSelection(
      collateral,
      'test',
      { caseId: 'cross-tree/approval-lanes', worldId: 'lossy-a' },
      expectedAdaptiveQualificationTarget('cross-tree/approval-lanes', 'lossy-a'),
    );
    expect(verifyAdaptiveQualificationSelection(collateral, { caseId, worldId })).toMatchObject({
      passed: false,
      mutationCount: 1,
      collateralMutationCount: 1,
      totalStudyMutationCount: 2,
    });
    collateral.close();
  });
});
