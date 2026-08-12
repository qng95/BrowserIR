import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { stableJson } from '../src/environment.js';
import type { PairedRuntimeProvenance } from '../src/agent-benchmark/paired-runtime-provenance.js';
import {
  capturePairedRuntimeProvenanceEnd,
  PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT,
  preparePairedRuntimeProvenanceStart,
} from '../src/agent-benchmark/paired-runtime-provenance-lifecycle.js';
import { renderPairedRuntimeProvenance } from '../src/agent-benchmark/paired-runtime-provenance.js';
import {
  PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES,
  PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES,
} from '../src/agent-benchmark/paired-runtime-provenance.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const digest = (character: string): string => character.repeat(64);
const sha256 = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');

const installed = (role: 'control' | 'treatment') => {
  const packages = (role === 'control'
    ? PAIRED_CONTROL_RUNTIME_PACKAGE_NAMES
    : PAIRED_TREATMENT_RUNTIME_PACKAGE_NAMES
  ).map((name, index) => {
    const packageUnsigned = {
      name,
      version: '1.62.0',
      files: [
        {
          path: 'index.js',
          kind: 'package_payload' as const,
          bytes: 1,
          sha256: digest(String(((index + (role === 'control' ? 1 : 3)) % 9) + 1)),
        },
        {
          path: 'package.json',
          kind: 'package_manifest' as const,
          bytes: 1,
          sha256: digest(String(((index + (role === 'control' ? 5 : 7)) % 9) + 1)),
        },
      ],
    } as const;
    return { ...packageUnsigned, sha256: sha256(packageUnsigned) };
  });
  const unsigned = {
    schemaVersion: '1.0.0' as const,
    packages: [...packages].sort((left, right) => left.name.localeCompare(right.name)),
    browser: {
    engine: 'chromium' as const,
    version: `151.0-${role}`,
    executableBytes: 1,
    executableSha256: digest(role === 'control' ? '5' : '6'),
    },
  } as const;
  return { ...unsigned, sha256: sha256(unsigned) };
};

const snapshot = (): PairedRuntimeProvenance => {
  const control = installed('control');
  const treatment = installed('treatment');
  const unsigned = {
    schemaVersion: '1.0.0',
    roles: { control, treatment },
  } as const;
  return { ...unsigned, sha256: sha256(unsigned) };
};

describe('paired runtime provenance artifact lifecycle', () => {
  it('creates the role-qualified start before an attempt and parses it before resume probes', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'browserir-paired-runtime-start-'));
    temporaryDirectories.push(outputDirectory);
    const events: string[] = [];
    const value = snapshot();

    const prepared = await preparePairedRuntimeProvenanceStart({
      outputDirectory,
      mode: 'create',
      collect: async () => {
        events.push('runtime-collected');
        return value;
      },
    });
    events.push('attempt-started');

    expect(events).toEqual(['runtime-collected', 'attempt-started']);
    expect(
      await readFile(
        join(outputDirectory, PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT),
        'utf8',
      ),
    ).toBe(prepared.rendered);

    await writeFile(
      join(outputDirectory, PAIRED_RUNTIME_PROVENANCE_START_ARTIFACT),
      '{not-json}\n',
    );
    let collectCalled = false;
    await expect(
      preparePairedRuntimeProvenanceStart({
        outputDirectory,
        mode: 'resume',
        collect: async () => {
          collectCalled = true;
          return value;
        },
      }),
    ).rejects.toThrow(/runtime-provenance-start|JSON/i);
    expect(collectCalled).toBe(false);
  });

  it('recaptures and verifies both roles at the endpoint', async () => {
    const value = snapshot();
    const captured = await capturePairedRuntimeProvenanceEnd({
      start: value,
      collect: async () => value,
    });

    expect(captured.end).toEqual(value);
    expect(captured.renderedStart).toBe(renderPairedRuntimeProvenance(value));
    expect(captured.renderedEnd).toBe(renderPairedRuntimeProvenance(value));
  });

  it('uses the strict public renderer by default', () => {
    expect(renderPairedRuntimeProvenance(snapshot())).toContain('"control"');
  });
});
