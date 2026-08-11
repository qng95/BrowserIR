import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectSealedBuildProvenance,
  renderSealedBuildProvenance,
  type SealedBuildPackageInput,
} from '../src/agent-benchmark/sealed-execution-provenance.js';
import {
  captureSealedExecutionBuildEnd,
  prepareSealedExecutionBuildStart,
  SEALED_EXECUTION_BUILD_START_ARTIFACT,
} from '../src/agent-benchmark/sealed-execution-provenance-lifecycle.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(): Promise<{
  outputDirectory: string;
  packages: SealedBuildPackageInput[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'browserir-build-lifecycle-'));
  temporaryDirectories.push(root);
  const outputDirectory = join(root, 'evidence');
  await mkdir(outputDirectory);
  const packages: SealedBuildPackageInput[] = [];
  for (const name of [
    '@browserir/core',
    '@browserir/playwright',
    '@browserir/mcp',
  ] as const) {
    const packageDirectory = join(root, name.split('/').at(-1)!);
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name, version: '0.1.0' })}\n`,
    );
    await writeFile(join(packageDirectory, 'dist', 'index.js'), `export const name = ${JSON.stringify(name)};\n`);
    packages.push({ name, packageDirectory });
  }
  return { outputDirectory, packages };
}

const collector = (packages: readonly SealedBuildPackageInput[]) => async () =>
  collectSealedBuildProvenance({ packages });

describe('sealed execution build provenance lifecycle', () => {
  it('creates an immutable canonical start artifact', async () => {
    const state = await fixture();
    const prepared = await prepareSealedExecutionBuildStart({
      outputDirectory: state.outputDirectory,
      mode: 'create',
      collect: collector(state.packages),
    });

    expect(
      await readFile(
        join(state.outputDirectory, SEALED_EXECUTION_BUILD_START_ARTIFACT),
        'utf8',
      ),
    ).toBe(renderSealedBuildProvenance(prepared.snapshot));
    await expect(
      prepareSealedExecutionBuildStart({
        outputDirectory: state.outputDirectory,
        mode: 'create',
        collect: collector(state.packages),
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('accepts an exact retained start on resume', async () => {
    const state = await fixture();
    const created = await prepareSealedExecutionBuildStart({
      outputDirectory: state.outputDirectory,
      mode: 'create',
      collect: collector(state.packages),
    });
    const resumed = await prepareSealedExecutionBuildStart({
      outputDirectory: state.outputDirectory,
      mode: 'resume',
      collect: collector(state.packages),
    });

    expect(resumed).toEqual(created);
  });

  it('parses the retained start before probing live files and rejects drift', async () => {
    const malformed = await fixture();
    await writeFile(
      join(malformed.outputDirectory, SEALED_EXECUTION_BUILD_START_ARTIFACT),
      '{}\n',
    );
    const probe = vi.fn(collector(malformed.packages));
    await expect(
      prepareSealedExecutionBuildStart({
        outputDirectory: malformed.outputDirectory,
        mode: 'resume',
        collect: probe,
      }),
    ).rejects.toThrow(/retained build-provenance-start\.json|invalid sealed build provenance/i);
    expect(probe).not.toHaveBeenCalled();

    const drifted = await fixture();
    await prepareSealedExecutionBuildStart({
      outputDirectory: drifted.outputDirectory,
      mode: 'create',
      collect: collector(drifted.packages),
    });
    await writeFile(
      join(drifted.packages[0]!.packageDirectory, 'dist', 'index.js'),
      'export const changed = true;\n',
    );
    await expect(
      prepareSealedExecutionBuildStart({
        outputDirectory: drifted.outputDirectory,
        mode: 'resume',
        collect: collector(drifted.packages),
      }),
    ).rejects.toThrow(/content changed/i);
  });

  it('captures an exact end artifact and fails closed on end drift', async () => {
    const stable = await fixture();
    const start = await prepareSealedExecutionBuildStart({
      outputDirectory: stable.outputDirectory,
      mode: 'create',
      collect: collector(stable.packages),
    });
    const end = await captureSealedExecutionBuildEnd({
      start: start.snapshot,
      collect: collector(stable.packages),
    });
    expect(end.renderedStart).toBe(start.rendered);
    expect(end.renderedEnd).toBe(start.rendered);
    expect(end.end.sha256).toBe(start.snapshot.sha256);

    await writeFile(
      join(stable.packages[2]!.packageDirectory, 'dist', 'index.js'),
      'export const changed = true;\n',
    );
    await expect(
      captureSealedExecutionBuildEnd({
        start: start.snapshot,
        collect: collector(stable.packages),
      }),
    ).rejects.toThrow(/content changed/i);
  });
});
