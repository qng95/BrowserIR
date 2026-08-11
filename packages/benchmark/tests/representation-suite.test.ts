import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CompiledView } from '@browserir/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REPRESENTATION_SCENARIO_IDS,
  runRepresentationGroundTruthSuite,
  scoreRepresentationCase,
  writeRepresentationArtifacts,
  type RepresentationCaseContract,
} from '../src/representation-suite.js';

const temporaryDirectories: string[] = [];
let browserSuite:
  | ReturnType<typeof runRepresentationGroundTruthSuite>
  | undefined;

const releaseSuite = () => {
  browserSuite ??= runRepresentationGroundTruthSuite({
    runId: 'deterministic-browser-test',
    headless: true,
  });
  return browserSuite;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const ref = (entityId: string) => ({
  browserId: 'browser-test',
  pageId: 'page-test',
  entityId,
  revision: 1,
});

const scoringView = (): CompiledView => ({
  browserId: 'browser-test',
  pageId: 'page-test',
  revision: 1,
  truncated: false,
  text: 'Save',
  structured: {
    page: { url: 'https://fixture.invalid/scoring' },
    entities: [
      {
        ref: ref('runtime-label'),
        kind: 'text',
        role: 'label',
        text: 'Commit changes',
        state: { visible: true },
        capabilities: [],
      },
      {
        ref: ref('runtime-save'),
        kind: 'control',
        role: 'button',
        name: 'Save',
        state: { visible: true, enabled: true },
        capabilities: [
          { kind: 'click', enabled: true },
          { kind: 'doubleClick', enabled: true },
        ],
      },
    ],
    relations: [
      {
        from: ref('runtime-label'),
        kind: 'labels',
        to: ref('runtime-save'),
      },
      {
        from: ref('runtime-save'),
        kind: 'controls',
        to: ref('runtime-label'),
      },
    ],
    omissions: [],
  },
});

const scoringContract: RepresentationCaseContract = {
  id: 'scoring-regression',
  entities: [
    {
      key: 'save-label',
      match: { kind: 'text', role: 'label', text: 'Commit changes' },
      capabilities: [],
    },
    {
      key: 'save',
      match: { kind: 'control', role: 'button', name: 'Save' },
      capabilities: ['click'],
    },
  ],
  relations: [{ from: 'save-label', kind: 'labels', to: 'save' }],
  relationKinds: ['labels', 'controls'],
  abstentions: [],
};

describe('representation ground-truth scoring', () => {
  it('counts false actionable capabilities and relations against precision', () => {
    const scored = scoreRepresentationCase(scoringContract, scoringView());

    expect(scored.metrics.capabilities).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      precision: 0.5,
    });
    expect(scored.metrics.relations).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      precision: 0.5,
    });
    expect(scored.matches).toEqual({
      'save-label': 'runtime-label',
      save: 'runtime-save',
    });
  });

  it('drives BrowserIR and Chromium across the checked-in release corpus', async () => {
    const result = await releaseSuite();

    expect(result.scenarios.map((scenario) => scenario.id)).toEqual(
      REPRESENTATION_SCENARIO_IDS,
    );
    expect(result.releaseGate).toEqual({ passed: true, failures: [] });
    expect(result.releaseReady).toBe(true);
    expect(result.report.taskSummary.failed).toBe(0);
    expect(result.report.representation).toMatchObject({
      entities: { precision: 1, recall: 1 },
      capabilities: { precision: 1, recall: 1 },
      relations: { precision: 1, recall: 1 },
      correctAbstention: { precision: 1, recall: 1 },
      identityStability: { rate: 1, changed: 0, missing: 0 },
      omissionAccounting: {
        exact: true,
        unreported: 0,
        overreported: 0,
      },
    });
    expect(result.report.payload).toMatchObject({
      characters: expect.any(Number),
      utf8Bytes: expect.any(Number),
    });
    expect(result.report.payload?.utf8Bytes).toBeGreaterThan(1_000);
    expect(result.modelPayloadNdjson.trimEnd().split('\n')).toHaveLength(
      REPRESENTATION_SCENARIO_IDS.length,
    );
  }, 90_000);

  it('writes immutable artifacts and cleans only files created by a failed write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browserir-representation-'));
    temporaryDirectories.push(directory);
    const result = await releaseSuite();

    await writeFile(join(directory, 'representation-report.md'), 'keep me\n');
    await expect(
      writeRepresentationArtifacts(directory, result),
    ).rejects.toThrow(/already exists|exist/i);

    expect(await readdir(directory)).toEqual(['representation-report.md']);
    expect(await readFile(join(directory, 'representation-report.md'), 'utf8')).toBe(
      'keep me\n',
    );

    const cleanDirectory = join(directory, 'clean');
    const paths = await writeRepresentationArtifacts(cleanDirectory, result);
    expect(Object.keys(paths).sort()).toEqual([
      'json',
      'junit',
      'markdown',
      'ndjson',
      'payloadNdjson',
    ]);
    expect((await readdir(cleanDirectory)).sort()).toEqual([
      'model-payload.ndjson',
      'representation-report.json',
      'representation-report.junit.xml',
      'representation-report.md',
      'representation-report.ndjson',
    ]);
  }, 90_000);
});
