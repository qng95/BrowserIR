import { TASKS } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_TASK_PLANNERS,
  parseBrowserIrObservation,
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
  });
});
