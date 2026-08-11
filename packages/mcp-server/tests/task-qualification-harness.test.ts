import { TASKS } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_TASK_PLANNERS,
  parseBrowserIrObservation,
  qualificationContinuationNeedsObserve,
} from './task-qualification-harness.js';

describe('fixture task qualification harness', () => {
  it('has one deterministic BrowserIR-reference planner for every fixture task', () => {
    expect(Object.keys(FIXTURE_TASK_PLANNERS).sort()).toEqual(
      TASKS.map((task) => task.id).sort(),
    );
  });

  it('retains entity roles and relations from the compact model view', () => {
    const observation = parseBrowserIrObservation(
      [
        'Page: Login',
        'URL: https://fixture.test/app/login',
        'Revision: 4',
        '[button@r4] control role="button" name="Sign in" state=enabled=true,visible=true actions=click',
        '[link@r4] control role="link" name="Sign in" state=enabled=true,visible=true actions=click',
        '[form@r4] form role="form" name="Login" state=visible=true',
        '[form@r4] contains [button@r4]',
      ].join('\n'),
      { browser_id: 'browser-1', page_id: 'page-1', revision: 4 },
    );

    expect(observation.entities.filter((entity) => entity.name === 'Sign in')).toEqual([
      expect.objectContaining({ id: 'button', role: 'button', actions: ['click'] }),
      expect.objectContaining({ id: 'link', role: 'link', actions: ['click'] }),
    ]);
    expect(observation.relations).toContainEqual({
      from: 'form',
      kind: 'contains',
      to: 'button',
    });
    expect(observation).toMatchObject({ scope: 'full', continuationOmitted: 0 });
  });

  it('retains fresh continuation targets from a delta-first action receipt', () => {
    const observation = parseBrowserIrObservation(
      'Action verified at revision 5; Delta only. Continue with fresh actionable_context targets using its page_id and revision.',
      {
        browser_id: 'browser-1',
        page_id: 'page-1',
        post_revision: 5,
        representation: 'delta',
        actionable_context: {
          page_id: 'page-1',
          revision: 5,
          targets: [
            {
              entity_id: 'password',
              kind: 'input',
              role: 'textbox',
              name: 'Password',
              value_present: false,
              actions: ['fill'],
            },
            {
              entity_id: 'submit',
              kind: 'control',
              role: 'button',
              name: 'Sign in',
              actions: ['click'],
            },
          ],
          omitted: 0,
        },
      },
    );

    expect(observation).toMatchObject({
      browserId: 'browser-1',
      pageId: 'page-1',
      revision: 5,
      scope: 'continuation',
      continuationOmitted: 0,
    });
    expect(observation.entities).toEqual([
      expect.objectContaining({
        id: 'password',
        revision: 5,
        kind: 'input',
        role: 'textbox',
        name: 'Password',
        state: { hasValue: false },
        actions: ['fill'],
      }),
      expect.objectContaining({
        id: 'submit',
        revision: 5,
        kind: 'control',
        role: 'button',
        name: 'Sign in',
        actions: ['click'],
      }),
    ]);
    expect(qualificationContinuationNeedsObserve(observation)).toBe(false);
  });

  it('rejects cross-page and cross-revision actionable continuation contexts', () => {
    const parse = (pageId: string, revision: number) => () =>
      parseBrowserIrObservation('Action verified; Delta only.', {
        browser_id: 'browser-1',
        page_id: 'page-1',
        post_revision: 5,
        representation: 'delta',
        actionable_context: {
          page_id: pageId,
          revision,
          targets: [],
          omitted: 1,
        },
      });

    expect(parse('page-2', 5)).toThrow(/page_id/);
    expect(parse('page-1', 4)).toThrow(/revision/);
  });

  it('rejects contradictory receipt revisions before parsing continuation targets', () => {
    expect(() =>
      parseBrowserIrObservation('Action verified; Delta only.', {
        browser_id: 'browser-1',
        page_id: 'page-1',
        revision: 4,
        post_revision: 5,
        representation: 'delta',
      }),
    ).toThrow(/revision.*post_revision/);
  });

  it('accepts a delta-first receipt with no continuation targets as an empty observation', () => {
    const observation = parseBrowserIrObservation('Action verified; Delta only.', {
      browser_id: 'browser-1',
      page_id: 'page-1',
      post_revision: 5,
      representation: 'delta',
    });

    expect(observation).toMatchObject({
      pageId: 'page-1',
      revision: 5,
      scope: 'continuation',
      continuationOmitted: 0,
      entities: [],
    });
    expect(qualificationContinuationNeedsObserve(observation)).toBe(true);
  });

  it('requires a full observe when compact continuation explicitly omits targets', () => {
    const observation = parseBrowserIrObservation('Action verified; Delta only.', {
      browser_id: 'browser-1',
      page_id: 'page-1',
      post_revision: 5,
      representation: 'delta',
      actionable_context: {
        page_id: 'page-1',
        revision: 5,
        targets: [
          {
            entity_id: 'next-field',
            kind: 'input',
            name: 'Next field',
            actions: ['fill'],
          },
        ],
        omitted: 2,
      },
    });

    expect(observation).toMatchObject({
      scope: 'continuation',
      continuationOmitted: 2,
    });
    expect(qualificationContinuationNeedsObserve(observation)).toBe(true);
  });

  it('rejects an actionable continuation context atomically when any target is malformed', () => {
    expect(() =>
      parseBrowserIrObservation('Action verified; Delta only.', {
        browser_id: 'browser-1',
        page_id: 'page-1',
        post_revision: 5,
        representation: 'delta',
        actionable_context: {
          page_id: 'page-1',
          revision: 5,
          targets: [
            {
              entity_id: 'password',
              kind: 'input',
              name: 'Password',
              actions: ['fill'],
            },
            {
              entity_id: 'submit',
              kind: 'control',
              name: 'Sign in',
            },
          ],
          omitted: 0,
        },
      }),
    ).toThrow(/target 2/);
  });
});
