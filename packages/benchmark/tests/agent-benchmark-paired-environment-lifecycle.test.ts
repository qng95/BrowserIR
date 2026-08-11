import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  capturePairedExecutionEnvironmentEnd,
  preparePairedExecutionEnvironmentStart,
  type PairedExecutionEnvironmentCollector,
} from '../src/agent-benchmark/paired-environment-lifecycle.js';
import type {
  PairedExecutionEnvironment,
  PairedExecutionEnvironmentCollectionOptions,
} from '../src/agent-benchmark/paired-environment.js';
import { renderPairedExecutionEnvironment } from '../src/agent-benchmark/paired-environment.js';

const digest = (character: string): string => character.repeat(64);

const environment = (): PairedExecutionEnvironment => ({
  schemaVersion: '1.0.0',
  host: { platform: 'darwin', release: '25.0.0', arch: 'arm64' },
  harness: {
    nodeVersion: 'v22.19.0',
    pnpmVersion: '10.30.3',
    packageManager: 'pnpm@10.30.3',
    lockfileSha256: digest('1'),
  },
  model: {
    provider: 'ollama',
    modelId: 'browserir-model',
    artifactDigest: `sha256:${digest('2')}`,
    verification: 'ollama-local-digest',
    runtime: { name: 'ollama', version: '0.11.4' },
    configuration: {
      contextWindowTokens: 32_768,
      temperature: 0,
      maxRetries: 0,
      imageMode: 'text-only',
    },
    capabilities: ['completion', 'tools'],
  },
  target: {
    expectedVersion: `sha256:${digest('3')}`,
    headless: true,
    profile: {
      viewport: { width: 1_440, height: 900, deviceScaleFactor: 1 },
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      reducedMotion: 'reduce',
    },
  },
  arms: {
    control: {
      interfaceVersion: '0.0.78',
      runtimePackages: [{ name: '@playwright/mcp', version: '0.0.78' }],
      browser: {
        engine: 'chromium',
        version: '144.0.0.0',
        executableSha256: digest('4'),
      },
    },
    treatment: {
      interfaceVersion: '0.1.0+mcp-2026-07-28',
      runtimePackages: [{ name: '@browserir/mcp', version: '0.1.0' }],
      browser: {
        engine: 'chromium',
        version: '144.0.0.0',
        executableSha256: digest('4'),
      },
    },
  },
});

const collectionOptions = (): PairedExecutionEnvironmentCollectionOptions => ({
  workspaceRoot: '/Users/private/workspace',
  protocol: {
    agent: {
      provider: 'ollama',
      baseUrl: 'http://user:password@localhost:11434/v1',
      modelId: 'browserir-model',
      modelDigest: `sha256:${digest('2')}`,
      contextWindowTokens: 32_768,
      temperature: 0,
      maxRetries: 0,
      imageMode: 'text-only',
    },
    target: { expectedVersion: `sha256:${digest('3')}`, headless: true },
    arms: {
      control: { interfaceVersion: '0.0.78' },
      treatment: { interfaceVersion: '0.1.0+mcp-2026-07-28' },
    },
  },
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('paired environment artifact lifecycle', () => {
  it('creates the immutable start snapshot before an attempt can begin', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-environment-start-'));
    temporaryDirectories.push(outputDirectory);
    const events: string[] = [];
    const collect: PairedExecutionEnvironmentCollector = async () => {
      events.push('environment-collected');
      return environment();
    };

    const prepared = await preparePairedExecutionEnvironmentStart({
      outputDirectory,
      mode: 'create',
      collectionOptions: collectionOptions(),
      collect,
    });
    events.push('attempt-started');

    expect(events).toEqual(['environment-collected', 'attempt-started']);
    expect(await readFile(join(outputDirectory, 'environment-start.json'), 'utf8')).toBe(
      prepared.rendered,
    );
    expect(prepared.rendered).not.toContain('/Users/private');
    expect(prepared.rendered).not.toContain('password');
    await expect(
      preparePairedExecutionEnvironmentStart({
        outputDirectory,
        mode: 'create',
        collectionOptions: collectionOptions(),
        collect,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('parses a retained start before probing the current environment on resume', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-environment-invalid-'));
    temporaryDirectories.push(outputDirectory);
    await writeFile(join(outputDirectory, 'environment-start.json'), '{not-json}\n');
    let collectCalled = false;

    await expect(
      preparePairedExecutionEnvironmentStart({
        outputDirectory,
        mode: 'resume',
        collectionOptions: collectionOptions(),
        collect: async () => {
          collectCalled = true;
          return environment();
        },
      }),
    ).rejects.toThrow(/environment-start|JSON/i);
    expect(collectCalled).toBe(false);
  });

  it('rejects resume environment drift before an attempt can begin', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-environment-drift-'));
    temporaryDirectories.push(outputDirectory);
    const retained = environment();
    await writeFile(
      join(outputDirectory, 'environment-start.json'),
      renderPairedExecutionEnvironment(retained),
    );
    const current = environment();
    current.model.runtime.version = '0.11.5';

    await expect(
      preparePairedExecutionEnvironmentStart({
        outputDirectory,
        mode: 'resume',
        collectionOptions: collectionOptions(),
        collect: async () => current,
      }),
    ).rejects.toThrow(/model\.runtime\.version/i);
  });

  it('recaptures the end and binds both snapshots to the final journal hash', async () => {
    const start = environment();
    const completed = await capturePairedExecutionEnvironmentEnd({
      start,
      collectionOptions: collectionOptions(),
      journalFinalEventSha256: digest('a'),
      collect: async () => environment(),
    });

    expect(completed.binding).toMatchObject({
      environmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentStartSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentEndSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      journalFinalEventSha256: digest('a'),
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(completed.renderedStart).toBe(completed.renderedEnd);
  });
});
