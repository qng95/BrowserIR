import { TASKS } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  actWithFreshTargetRetry,
  FIXTURE_TASK_PLANNERS,
  latestObservationArguments,
  parseBrowserIrObservation,
  publicSafeToolArgumentsDiagnostic,
  QualificationToolError,
  qualificationContinuationNeedsObserve,
} from './task-qualification-harness.js';

describe('fixture task qualification harness', () => {
  it('records only flat public-safe fill and drag action targets', () => {
    const secret = 'SENTINEL-QUALIFICATION-VALUE-4917';

    expect(
      publicSafeToolArgumentsDiagnostic({
        kind: 'fill',
        target_ref: 'e12@r7',
        value: secret,
      }),
    ).toEqual({ action: 'fill', target: 'e12@r7' });
    expect(
      publicSafeToolArgumentsDiagnostic({
        kind: 'drag',
        source_ref: 'e3@r11',
        destination_ref: 'e9@r11',
        note: secret,
      }),
    ).toEqual({ action: 'drag', target: 'e3@r11 -> e9@r11' });

    const serialized = JSON.stringify([
      publicSafeToolArgumentsDiagnostic({
        kind: secret,
        target_ref: `${secret}@r7`,
      }),
    ]);
    expect(serialized).not.toContain(secret);
  });

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
      'Action verified at revision 5; Delta only. Continue with fresh actionable_context target_ref tokens.',
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
              target_ref: 'e1@r5',
              kind: 'input',
              role: 'textbox',
              name: 'Password',
              value_present: false,
              actions: ['fill'],
            },
            {
              target_ref: 'e2@r5',
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
        id: 'e1',
        revision: 5,
        kind: 'input',
        role: 'textbox',
        name: 'Password',
        state: { hasValue: false },
        actions: ['fill'],
      }),
      expect.objectContaining({
        id: 'e2',
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
            target_ref: 'e1@r5',
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
              target_ref: 'e1@r5',
              kind: 'input',
              name: 'Password',
              actions: ['fill'],
            },
            {
              target_ref: 'e2@r5',
              kind: 'control',
              name: 'Sign in',
            },
          ],
          omitted: 0,
        },
      }),
    ).toThrow(/target 2/);
  });

  it('refreshes and re-resolves once after a stale target but never retries another failure', async () => {
    let target = 'old-target';
    const refresh = async (): Promise<void> => {
      target = 'fresh-target';
    };
    const attempts: string[] = [];

    await expect(
      actWithFreshTargetRetry({
        resolve: async () => target,
        refresh,
        act: async (resolved) => {
          attempts.push(resolved);
          if (resolved === 'old-target') {
            throw new QualificationToolError({
              tool: 'browser_act',
              status: 'stale_target',
              dispatched: false,
              summary: 'Action stale_target.',
            });
          }
          return 'clicked';
        },
      }),
    ).resolves.toBe('clicked');
    expect(attempts).toEqual(['old-target', 'fresh-target']);
    expect(
      latestObservationArguments({ browserId: 'browser-1', pageId: 'page-1' }),
    ).toEqual({
      browser_id: 'browser-1',
      page_id: 'page-1',
      max_tokens: 100_000,
    });

    let nonStaleRefreshes = 0;
    await expect(
      actWithFreshTargetRetry({
        resolve: () => 'target',
        refresh: async () => {
          nonStaleRefreshes += 1;
        },
        act: async () => {
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'blocked',
            dispatched: false,
            summary: 'Action blocked.',
          });
        },
      }),
    ).rejects.toThrow(/blocked/);
    expect(nonStaleRefreshes).toBe(0);

    let dispatchedRefreshes = 0;
    await expect(
      actWithFreshTargetRetry({
        resolve: () => 'target',
        refresh: async () => {
          dispatchedRefreshes += 1;
        },
        act: async () => {
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'stale_target',
            dispatched: true,
            summary: 'Action state is uncertain.',
          });
        },
      }),
    ).rejects.toThrow(/uncertain/);
    expect(dispatchedRefreshes).toBe(0);

    let secondStaleAttempts = 0;
    await expect(
      actWithFreshTargetRetry({
        resolve: () => `target-${secondStaleAttempts}`,
        refresh: async () => {},
        act: async () => {
          secondStaleAttempts += 1;
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'stale_target',
            dispatched: false,
            summary: 'Action stale_target.',
          });
        },
      }),
    ).rejects.toThrow(/stale_target/);
    expect(secondStaleAttempts).toBe(2);

    let resolveFresh = false;
    let missingTargetActions = 0;
    await expect(
      actWithFreshTargetRetry({
        resolve: () => {
          if (resolveFresh) throw new Error('Expected exactly one refreshed target; found 0.');
          return 'old-target';
        },
        refresh: async () => {
          resolveFresh = true;
        },
        act: async () => {
          missingTargetActions += 1;
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'stale_target',
            dispatched: false,
            summary: 'Action stale_target.',
          });
        },
      }),
    ).rejects.toThrow(/found 0/);
    expect(missingTargetActions).toBe(1);

    await expect(
      actWithFreshTargetRetry({
        resolve: () => 'target',
        refresh: async () => {
          throw new Error('must not refresh');
        },
        act: async () => {
          throw new Error('browser_act failed: Action stale_target.');
        },
      }),
    ).rejects.toThrow(/stale_target/);
  });

  it('recovers an inline edit when asynchronous revisions stale its cell or editor before dispatch', async () => {
    type FakeEntity = { id: string; kind: string; text?: string; name?: string };
    const row = { id: 'ticket-row', kind: 'row', text: 'T-1005' };
    let refreshes = 0;
    const cells = (): FakeEntity[] => [
      { id: 'priority-cell-r5', kind: 'cell', text: 'Normal' },
      {
        id: refreshes === 0 ? 'assignee-cell-r7' : 'assignee-cell-r8',
        kind: 'cell',
        text: 'Unassigned',
      },
    ];
    let assigneeOpenAttempts = 0;
    let assigneeSelectAttempts = 0;
    const opened: string[] = [];
    const selected: string[] = [];
    const fakeAgent = {
      signIn: async () => {},
      navigate: async () => {},
      rowContaining: () => row,
      inside: async (
        _container: typeof row,
        predicate: (entity: FakeEntity) => boolean,
      ) => cells().filter(predicate),
      act: async ({ target }: { target: FakeEntity }) => {
        opened.push(target.id);
        if (target.id === 'assignee-cell-r7' && assigneeOpenAttempts++ === 0) {
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'stale_target',
            dispatched: false,
            summary: 'A transient UI update advanced the page revision.',
          });
        }
      },
      find: ({ name }: { name?: string }) => ({
        id:
          name === 'priority'
            ? 'priority-editor-r6'
            : refreshes >= 2
              ? 'assignee-editor-r9'
              : 'assignee-editor-r8',
        kind: 'input',
        name,
      }),
      select: async (editor: { id: string }, value: string) => {
        selected.push(`${editor.id}:${value}`);
        if (editor.id === 'assignee-editor-r8' && assigneeSelectAttempts++ === 0) {
          throw new QualificationToolError({
            tool: 'browser_act',
            status: 'stale_target',
            dispatched: false,
            summary: 'A transient UI update advanced the page revision.',
          });
        }
      },
      observeLatest: async () => {
        refreshes += 1;
      },
      waitSettled: async () => {},
    };

    await expect(
      FIXTURE_TASK_PLANNERS['triage-ticket']!(fakeAgent as never),
    ).resolves.toBeUndefined();
    expect(opened).toEqual([
      'priority-cell-r5',
      'assignee-cell-r7',
      'assignee-cell-r8',
    ]);
    expect(selected).toEqual([
      'priority-editor-r6:Urgent',
      'assignee-editor-r8:M. Roth',
      'assignee-editor-r9:M. Roth',
    ]);
    expect(refreshes).toBe(2);
  });
});
