import { describe, expect, it } from 'vitest';

import type { ObservationResult } from '@browserir/core';

import {
  BROWSERIR_OBSERVATION_METHODOLOGY,
  BROWSERIR_OBSERVATION_TARGETS,
} from '../src/browserir-suite.js';
import {
  runWarmObservationTarget,
  type WarmObservationRuntime,
} from '../src/internal/warm-observation.js';

const observation = (revision: number, url: string): ObservationResult => ({
  snapshot: {
    browserId: 'browser-1',
    pageId: 'page-1',
    revision,
    url,
    entities: [],
    relations: [],
  },
  delta: {
    fromRevision: Math.max(0, revision - 1),
    toRevision: revision,
    pageChanged: false,
    added: [],
    removed: [],
    changed: [],
    addedRelations: [],
    removedRelations: [],
    invalidatedRefs: [],
  },
  view: {
    browserId: 'browser-1',
    pageId: 'page-1',
    revision,
    text: `revision ${revision}`,
    truncated: false,
    structured: {
      page: { url },
      entities: [],
      relations: [],
      omissions: [],
    },
  },
});

describe('BrowserIR observation workload contract', () => {
  it('covers the materially different enterprise page shapes with unique stable IDs', () => {
    expect(BROWSERIR_OBSERVATION_METHODOLOGY).toBe('warm-steady-state');
    expect(BROWSERIR_OBSERVATION_TARGETS.map((target) => target.id)).toEqual([
      'observe-warm/customers-5000',
      'observe-warm/vehicles-12000-virtualized',
      'observe-warm/orders-draft-table',
      'observe-warm/workshop-spatial-grid',
      'observe-warm/parts-master-detail',
      'observe-warm/query-builder',
      'observe-warm/staged-dashboard',
    ]);
    expect(new Set(BROWSERIR_OBSERVATION_TARGETS.map((target) => target.path)).size).toBe(
      BROWSERIR_OBSERVATION_TARGETS.length,
    );
  });

  it('navigates and settles exactly once, then times only warm observe calls', async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    let clock = 0;
    let revision = 1;
    const runtime: WarmObservationRuntime = {
      async navigate(input) {
        calls.push(`navigate:${input.url}`);
        clock += 1_000;
        revision += 1;
        return observation(revision, input.url);
      },
      async wait(input) {
        calls.push(`settle:${input.expectedRevision}`);
        clock += 2_000;
        revision += 1;
        return observation(revision, 'https://fixture.test/app/customers');
      },
      async observe() {
        calls.push('observe');
        clock += 7;
        revision += 1;
        return observation(revision, 'https://fixture.test/app/customers');
      },
    };

    const run = await runWarmObservationTarget({
      target: {
        id: 'observe-warm/customers-5000',
        path: '/app/customers',
      },
      runtime,
      browserId: 'browser-1',
      pageId: 'page-1',
      origin: 'https://fixture.test',
      current: observation(revision, 'https://fixture.test/app/home'),
      warmups: 2,
      samples: 3,
      maxCharacters: 16_000,
      now: () => clock,
      onProgress: (message) => progress.push(message),
    });

    expect(calls.filter((call) => call.startsWith('navigate:'))).toEqual([
      'navigate:https://fixture.test/app/customers',
    ]);
    expect(calls.filter((call) => call.startsWith('settle:'))).toHaveLength(1);
    expect(calls.filter((call) => call === 'observe')).toHaveLength(5);
    expect(run.result.samples.map((sample) => sample.durationMs)).toEqual([7, 7, 7]);
    expect(run.result.samples.map((sample) => sample.iteration)).toEqual([0, 1, 2]);
    expect(progress).toEqual([
      'observe-warm/customers-5000: navigating and settling once before timing',
      'observe-warm/customers-5000: warmup 1/5',
      'observe-warm/customers-5000: warmup 2/5',
      'observe-warm/customers-5000: sample 3/5',
      'observe-warm/customers-5000: sample 4/5',
      'observe-warm/customers-5000: sample 5/5',
    ]);
  });
});
