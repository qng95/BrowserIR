import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPairedAgentBenchmarkCompletionMarker,
  parsePairedAgentBenchmarkCompletionMarker,
  readPairedAgentBenchmarkCompletionMarker,
  renderAgentBenchmarkChecksums,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];
const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('paired agent benchmark completion marker', () => {
  it('distinguishes journal-complete unfinalized evidence from finalized evidence', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-complete-'));
    temporaryDirectories.push(output);
    const artifacts = {
      'attempts.ndjson': '{"attempt":true}\n',
      'comparison.json': '{"comparison":true}\n',
      'execution.json': '{"stage":"completed"}\n',
      'journal.ndjson': '{"event":"run_completed"}\n',
      'summary.md': '# Complete\n',
    };
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(output, name), content, 'utf8');
    }
    const checksums = renderAgentBenchmarkChecksums(artifacts);
    await writeFile(join(output, 'SHA256SUMS'), checksums, 'utf8');

    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toBeUndefined();

    const marker = await createPairedAgentBenchmarkCompletionMarker(output, {
      runId: 'drop-01-development-run',
      protocolId: 'drop-01-development-v5',
      protocolSha256: 'b'.repeat(64),
      journalFinalEventSha256: 'c'.repeat(64),
    });

    expect(marker).toMatchObject({
      schemaVersion: '1.0.0',
      state: 'complete',
      artifactManifestSha256: digest(checksums),
    });
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toEqual(marker);
    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, {
        runId: 'drop-01-development-run',
        protocolId: 'drop-01-development-v5',
        protocolSha256: 'b'.repeat(64),
        journalFinalEventSha256: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/complete|exist|finalized/i);

    await writeFile(join(output, 'summary.md'), '# Changed after finalization\n', 'utf8');
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).rejects.toThrow(
      /artifact|digest|manifest/i,
    );
  });

  it('requires finalized checksums before exposing COMPLETE.json', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-incomplete-'));
    temporaryDirectories.push(output);

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, {
        runId: 'drop-01-development-run',
        protocolId: 'drop-01-development-v5',
        protocolSha256: 'b'.repeat(64),
        journalFinalEventSha256: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/SHA256SUMS|artifact/i);
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toBeUndefined();
  });

  it('strictly parses marker schema and rejects unknown or malformed fields', () => {
    const valid = {
      schemaVersion: '1.0.0',
      state: 'complete',
      runId: 'drop-01-development-run',
      protocolId: 'drop-01-development-v5',
      protocolSha256: 'b'.repeat(64),
      journalFinalEventSha256: 'c'.repeat(64),
      artifactManifestSha256: 'd'.repeat(64),
    };
    expect(parsePairedAgentBenchmarkCompletionMarker(valid)).toEqual(valid);
    expect(() => parsePairedAgentBenchmarkCompletionMarker({ ...valid, extra: true })).toThrow(
      /completion|invalid|unrecognized/i,
    );
    expect(() =>
      parsePairedAgentBenchmarkCompletionMarker({ ...valid, protocolSha256: 'not-a-digest' }),
    ).toThrow(/completion|invalid|digest/i);
  });

  it('fails closed on a corrupt retained COMPLETE.json', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-corrupt-complete-'));
    temporaryDirectories.push(output);
    await writeFile(join(output, 'COMPLETE.json'), '{"state":"complete"}\n', 'utf8');

    await expect(readPairedAgentBenchmarkCompletionMarker(output)).rejects.toThrow(
      /completion|invalid/i,
    );
    expect(await readFile(join(output, 'COMPLETE.json'), 'utf8')).toBe(
      '{"state":"complete"}\n',
    );
  });
});
