import { describe, expect, it } from 'vitest';

import type {
  PairedAgentBenchmarkCompletionMarker,
  ReconstructedDevelopmentRun,
} from '../src/agent-benchmark/index.js';
import {
  assertPairedUpliftSourceBinding,
  classifyPairedUpliftResume,
} from '../src/uplift-cli-lifecycle.js';

const digest = (character: string): string => character.repeat(64);

const retained = (complete: boolean): ReconstructedDevelopmentRun => ({
  run: {
    type: 'run_started',
    runId: 'drop-01-development-run',
    protocolId: 'drop-01-development-v5',
    protocolSha256: digest('a'),
    phase: 'development',
    scheduledBlocks: 1,
  },
  blocks: [],
  complete,
  ...(complete
    ? {
        completed: {
          type: 'run_completed' as const,
          runId: 'drop-01-development-run',
          scheduledBlocks: 1,
          completedBlocks: 1,
          validBlocks: 1,
          invalidBlocks: 0,
        },
      }
    : {}),
  events: [
    {
      schemaVersion: '1.0.0',
      sequence: 0,
      recordedAt: '2026-08-11T00:00:00.000Z',
      previousEventSha256: null,
      event: {
        type: 'run_started',
        runId: 'drop-01-development-run',
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
        phase: 'development',
        scheduledBlocks: 1,
      },
      eventSha256: complete ? digest('f') : digest('e'),
    },
  ],
});

const completion = (): PairedAgentBenchmarkCompletionMarker => ({
  schemaVersion: '1.0.0',
  state: 'complete',
  runId: 'drop-01-development-run',
  protocolId: 'drop-01-development-v5',
  protocolSha256: digest('a'),
  journalFinalEventSha256: digest('f'),
  artifactManifestSha256: digest('b'),
});

describe('paired uplift CLI resume lifecycle', () => {
  it('accepts only a clean frozen source binding for sealed execution', () => {
    expect(() =>
      assertPairedUpliftSourceBinding({
        phase: 'sealed',
        freezeRef: 'evidence-drop-01-freeze',
        clean: true,
        revision: digest('1'),
        tree: digest('2'),
        frozenRevision: digest('1'),
        manifestRelativePath: 'docs/evidence-drops/drop-01/sealed.protocol.json',
        manifestSource: '{"phase":"sealed"}\n',
        committedManifestSource: '{"phase":"sealed"}\n',
      }),
    ).not.toThrow();
    expect(() =>
      assertPairedUpliftSourceBinding({
        phase: 'development',
        clean: false,
        revision: null,
        tree: null,
        manifestSource: '{}\n',
      }),
    ).not.toThrow();
  });

  it('fails closed for dirty, unfrozen, external, or changed sealed source', () => {
    const valid = {
      phase: 'sealed' as const,
      freezeRef: 'evidence-drop-01-freeze',
      clean: true,
      revision: digest('1'),
      tree: digest('2'),
      frozenRevision: digest('1'),
      manifestRelativePath: 'docs/evidence-drops/drop-01/sealed.protocol.json',
      manifestSource: '{"phase":"sealed"}\n',
      committedManifestSource: '{"phase":"sealed"}\n',
    };

    expect(() => assertPairedUpliftSourceBinding({ ...valid, clean: false })).toThrow(
      /clean Git worktree/i,
    );
    expect(() =>
      assertPairedUpliftSourceBinding({ ...valid, freezeRef: undefined }),
    ).toThrow(/freezeRef/i);
    expect(() =>
      assertPairedUpliftSourceBinding({ ...valid, frozenRevision: digest('9') }),
    ).toThrow(/does not resolve to current HEAD/i);
    expect(() =>
      assertPairedUpliftSourceBinding({ ...valid, manifestRelativePath: '../outside.json' }),
    ).toThrow(/inside the workspace/i);
    expect(() =>
      assertPairedUpliftSourceBinding({ ...valid, committedManifestSource: '{}\n' }),
    ).toThrow(/manifest bytes differ/i);
  });

  it('continues an interrupted journal and finalizes a complete unmarked journal', () => {
    expect(
      classifyPairedUpliftResume({
        retained: retained(false),
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toEqual({ mode: 'continue', runId: 'drop-01-development-run' });
    expect(
      classifyPairedUpliftResume({
        retained: retained(true),
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toEqual({ mode: 'finalize_only', runId: 'drop-01-development-run' });
  });

  it('validates a retained completion marker and rejects an already finalized run', () => {
    expect(() =>
      classifyPairedUpliftResume({
        retained: retained(true),
        completion: completion(),
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toThrow(/already finalized/i);
  });

  it('fails closed when completion identity or journal binding drifts', () => {
    expect(() =>
      classifyPairedUpliftResume({
        retained: retained(true),
        completion: { ...completion(), journalFinalEventSha256: digest('9') },
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toThrow(/completion.*drift|drift.*completion/i);
    expect(() =>
      classifyPairedUpliftResume({
        retained: retained(true),
        completion: { ...completion(), protocolId: 'other-protocol' },
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toThrow(/completion.*drift|drift.*completion/i);
  });

  it('rejects a completion marker attached to an incomplete journal', () => {
    expect(() =>
      classifyPairedUpliftResume({
        retained: retained(false),
        completion: completion(),
        protocolId: 'drop-01-development-v5',
        protocolSha256: digest('a'),
      }),
    ).toThrow(/completion.*incomplete|incomplete.*completion/i);
  });
});
