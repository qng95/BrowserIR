import { describe, expect, it } from 'vitest';

import { runScenario } from '../src/runner.js';

describe('benchmark scenario runner', () => {
  it('excludes warmups and isolates every measured sample', async () => {
    const events: string[] = [];
    let clock = 0;

    const result = await runScenario({
      id: 'unit/sample',
      warmups: 2,
      samples: 3,
      now: () => {
        clock += 5;
        return clock;
      },
      setup: async (iteration, measured) => {
        events.push(`setup:${iteration}:${measured}`);
        return { iteration };
      },
      run: async ({ iteration }) => {
        events.push(`run:${iteration}`);
        return { payloadBytes: iteration + 10 };
      },
      teardown: async ({ iteration }, measured) => {
        events.push(`teardown:${iteration}:${measured}`);
      },
    });

    expect(result.samples).toHaveLength(3);
    expect(result.samples.map((sample) => sample.iteration)).toEqual([0, 1, 2]);
    expect(result.samples.map((sample) => sample.durationMs)).toEqual([5, 5, 5]);
    expect(result.samples.map((sample) => sample.payloadBytes)).toEqual([12, 13, 14]);
    expect(events).toEqual([
      'setup:0:false',
      'run:0',
      'teardown:0:false',
      'setup:1:false',
      'run:1',
      'teardown:1:false',
      'setup:2:true',
      'run:2',
      'teardown:2:true',
      'setup:3:true',
      'run:3',
      'teardown:3:true',
      'setup:4:true',
      'run:4',
      'teardown:4:true',
    ]);
  });

  it('always tears down a failed iteration and identifies the scenario', async () => {
    let tornDown = false;
    await expect(
      runScenario({
        id: 'unit/failure',
        warmups: 0,
        samples: 1,
        setup: async () => 'state',
        run: async () => {
          throw new Error('boom');
        },
        teardown: async () => {
          tornDown = true;
        },
      }),
    ).rejects.toThrow(/unit\/failure.*boom/i);
    expect(tornDown).toBe(true);
  });
});
