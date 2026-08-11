import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stableJson } from '../src/environment.js';
import {
  createPairedExecutionIntegrityBinding,
  createPairedAgentBenchmarkCompletionMarker,
  modelFacingToolCatalogSha256,
  parsePairedAgentBenchmarkCompletionMarker,
  readPairedAgentBenchmarkCompletionMarker,
  renderAgentBenchmarkChecksums,
  renderPairedExecutionEnvironment,
  renderSealedBuildProvenance,
  type AgentToolDescriptor,
  type PairedExecutionEnvironment,
  type SealedBuildProvenance,
} from '../src/agent-benchmark/index.js';

const temporaryDirectories: string[] = [];
const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const runId = 'drop-01-development-run';
const protocolId = 'drop-01-development-v5';

const prettyStableJson = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(stableJson(value)) as unknown, null, 2)}\n`;

const executionEnvironment = (): PairedExecutionEnvironment => ({
  schemaVersion: '1.1.0',
  host: {
    platform: 'darwin',
    release: '25.0.0',
    arch: 'arm64',
    hardware: {
      cpuModel: 'Apple M4 Pro',
      logicalCpuCount: 14,
      memoryBytes: 51_539_607_552,
    },
    resourceLimits: {
      attemptConcurrency: 1,
      processBoundary: false,
      containerOrVmLimits: 'unverified',
    },
  },
  harness: {
    nodeVersion: 'v22.19.0',
    pnpmVersion: '10.30.3',
    packageManager: 'pnpm@10.30.3',
    lockfileSha256: digest('lockfile'),
  },
  model: {
    provider: 'ollama',
    modelId: 'browserir-qwen3-8b-32k:drop01-dev',
    artifactDigest: `sha256:${digest('model')}`,
    verification: 'ollama-endpoint-reported-digest',
    runtime: { name: 'ollama', version: '0.11.4' },
    configuration: {
      contextWindowTokens: 32_768,
      temperature: 0,
      maxRetries: 0,
      imageMode: 'text-only',
    },
    capabilities: ['completion', 'thinking', 'tools'],
  },
  target: {
    expectedVersion: `sha256:${digest('target')}`,
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
      runtimePackages: [
        { name: '@playwright/mcp', version: '0.0.78' },
        { name: 'playwright-core', version: '1.62.0' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('browser'),
      },
    },
    treatment: {
      interfaceVersion: '0.1.0+mcp-2026-07-28',
      runtimePackages: [
        { name: '@browserir/core', version: '0.1.0' },
        { name: '@browserir/mcp', version: '0.1.0' },
        { name: '@browserir/playwright', version: '0.1.0' },
        { name: 'playwright-core', version: '1.62.0' },
      ],
      browser: {
        engine: 'chromium',
        version: '144.0.7559.3',
        executableSha256: digest('browser'),
      },
    },
  },
});

const modelFacingCatalog = (role: 'control' | 'treatment'): AgentToolDescriptor[] => [
  {
    name: role === 'control' ? 'browser_snapshot' : 'browser_observe',
    description: `Observe with the ${role} arm.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const sealedBuildProvenance = (variant = 'stable'): SealedBuildProvenance => {
  const packages = (
    ['@browserir/core', '@browserir/mcp', '@browserir/playwright'] as const
  ).map((name) => {
    const files = [
      { path: 'dist/index.js', bytes: 10, sha256: digest(`${variant}:${name}:dist`) },
      { path: 'package.json', bytes: 20, sha256: digest(`${variant}:${name}:manifest`) },
    ];
    const unsigned = { name, version: '0.1.0', files };
    return { ...unsigned, sha256: digest(stableJson(unsigned)) };
  });
  const unsigned = { schemaVersion: '1.0.0' as const, packages };
  return { ...unsigned, sha256: digest(stableJson(unsigned)) };
};

function journalNdjson(
  phase: 'development' | 'sealed',
  protocolSha256: string,
  mode: 'complete' | 'shortcut' = 'complete',
): {
  source: string;
  finalEventSha256: string;
} {
  const taskId = 'paired-task';
  const blockId = `${runId}:${taskId}:0`;
  const attempt = (role: 'control' | 'treatment') => ({
    attemptId: `${blockId}:${role}`,
    taskId,
    taskVersion: 'task-v1',
    trialIndex: 0,
    outcome: 'passed',
    targetId: `${role}-target`,
    targetVersion: 'fixture-v1',
    agentStatus: 'completed',
    submissionAttempts: 1,
    modelTurns: 1,
    durationMs: 10,
    tools: {
      calls: 1,
      errors: 0,
      byTool: { browser_snapshot: 1 },
      budgetExceeded: false,
      policyViolationCount: 0,
    },
    agent: {
      adapterId: 'shared-agent',
      framework: 'langchain-create-agent',
      frameworkVersion: '1.5.5',
      model: 'model-snapshot',
    },
  });
  const runStarted = {
    type: 'run_started',
    runId,
    protocolId,
    protocolSha256,
    phase,
    protocolBinding: phase === 'sealed' ? 'frozen_verified' : 'development',
    scheduledBlocks: 1,
  };
  const runCompleted = {
    type: 'run_completed',
    runId,
    scheduledBlocks: 1,
    completedBlocks: 1,
    validBlocks: 1,
    invalidBlocks: 0,
  };
  const events =
    mode === 'shortcut'
      ? [runStarted, runCompleted]
      : [
          runStarted,
          {
            type: 'block_started',
            blockId,
            taskId,
            taskVersion: 'task-v1',
            trialIndex: 0,
            order: ['control', 'treatment'],
          },
          {
            type: 'attempt_started',
            blockId,
            attemptId: attempt('control').attemptId,
            taskId,
            trialIndex: 0,
            role: 'control',
          },
          {
            type: 'attempt_completed',
            blockId,
            role: 'control',
            attempt: attempt('control'),
          },
          {
            type: 'attempt_started',
            blockId,
            attemptId: attempt('treatment').attemptId,
            taskId,
            trialIndex: 0,
            role: 'treatment',
          },
          {
            type: 'attempt_completed',
            blockId,
            role: 'treatment',
            attempt: attempt('treatment'),
          },
          {
            type: 'block_completed',
            blockId,
            outcome: 'both_passed',
            integrityFailures: [],
          },
          runCompleted,
        ];
  let previousEventSha256: string | null = null;
  const lines = events.map((event, sequence) => {
    const unsigned = {
      schemaVersion: '1.0.0',
      sequence,
      recordedAt: new Date(Date.UTC(2026, 7, 11, 12, sequence)).toISOString(),
      previousEventSha256,
      event,
    };
    const envelope = {
      ...unsigned,
      eventSha256: digest(stableJson(unsigned)),
    };
    previousEventSha256 = envelope.eventSha256;
    return stableJson(envelope);
  });
  return {
    source: `${lines.join('\n')}\n`,
    finalEventSha256: previousEventSha256!,
  };
}

function completeArtifacts(
  phase: 'development' | 'sealed' = 'development',
  journalMode: 'complete' | 'shortcut' = 'complete',
): {
  artifacts: Record<string, string>;
  input: {
    runId: string;
    protocolId: string;
    protocolSha256: string;
    journalFinalEventSha256: string;
  };
} {
  const protocol = `${JSON.stringify({ phase, protocolId })}\n`;
  const protocolSha256 = digest(protocol);
  const journal = journalNdjson(phase, protocolSha256, journalMode);
  const environmentStart = executionEnvironment();
  const environmentEnd = executionEnvironment();
  const environment = createPairedExecutionIntegrityBinding(
    environmentStart,
    environmentEnd,
    journal.finalEventSha256,
  );
  const source = {
    revision: '1'.repeat(40),
    tree: '2'.repeat(40),
    clean: phase === 'sealed',
    ...(phase === 'sealed' ? { freezeRef: 'paired-uplift-v1' } : {}),
  };
  const sourceEnd = { ...source };
  const controlCatalog = modelFacingCatalog('control');
  const treatmentCatalog = modelFacingCatalog('treatment');
  const toolCatalogs = {
    control: {
      sha256: modelFacingToolCatalogSha256(controlCatalog),
      toolCount: controlCatalog.length,
    },
    treatment: {
      sha256: modelFacingToolCatalogSha256(treatmentCatalog),
      toolCount: treatmentCatalog.length,
    },
  };
  const build = phase === 'sealed' ? sealedBuildProvenance() : undefined;
  const artifacts: Record<string, string> = {
    'attempts.ndjson': '{"attempt":true}\n',
    'comparison.json': `${JSON.stringify({ phase, runId, protocolId, protocolSha256 })}\n`,
    'control-tool-catalog.json': prettyStableJson(controlCatalog),
    'environment-end.json': renderPairedExecutionEnvironment(environmentEnd),
    'environment-start.json': renderPairedExecutionEnvironment(environmentStart),
    'execution-start.json': prettyStableJson({
      schemaVersion: '1.0.0',
      stage: 'started',
      runId,
      protocolId,
      protocolSha256,
      source,
      toolCatalogs,
    }),
    'execution.json': prettyStableJson({
      schemaVersion: '1.0.0',
      stage: 'completed',
      runId,
      protocolId,
      protocolSha256,
      source,
      sourceEnd,
      ...(build === undefined
        ? {}
        : {
            buildProvenance: {
              startSha256: build.sha256,
              endSha256: build.sha256,
            },
          }),
      toolCatalogs,
      journal: { finalEventSha256: journal.finalEventSha256 },
      environment,
    }),
    'journal.ndjson': journal.source,
    'protocol.json': protocol,
    'summary.md': '# Complete\n',
    'system-prompt.txt': 'Use browser tools.\n',
    'treatment-tool-catalog.json': prettyStableJson(treatmentCatalog),
    ...(phase === 'sealed'
      ? {
          'build-provenance-start.json': renderSealedBuildProvenance(build!),
          'build-provenance-end.json': renderSealedBuildProvenance(build!),
        }
      : {}),
  };
  return {
    artifacts,
    input: { runId, protocolId, protocolSha256, journalFinalEventSha256: journal.finalEventSha256 },
  };
}

async function materializeArtifacts(
  prefix: string,
  artifacts: Record<string, string>,
): Promise<string> {
  const output = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(output);
  for (const [name, content] of Object.entries(artifacts)) {
    await writeFile(join(output, name), content, 'utf8');
  }
  await writeFile(
    join(output, 'SHA256SUMS'),
    renderAgentBenchmarkChecksums(artifacts),
    'utf8',
  );
  return output;
}

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
    const { artifacts, input } = completeArtifacts();
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(output, name), content, 'utf8');
    }
    const checksums = renderAgentBenchmarkChecksums(artifacts);
    await writeFile(join(output, 'SHA256SUMS'), checksums, 'utf8');

    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toBeUndefined();

    const marker = await createPairedAgentBenchmarkCompletionMarker(output, input);

    expect(marker).toMatchObject({
      schemaVersion: '1.0.0',
      state: 'complete',
      artifactManifestSha256: digest(checksums),
    });
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).resolves.toEqual(marker);
    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, input),
    ).rejects.toThrow(/complete|exist|finalized/i);

    await writeFile(join(output, 'summary.md'), '# Changed after finalization\n', 'utf8');
    await expect(readPairedAgentBenchmarkCompletionMarker(output)).rejects.toThrow(
      /artifact|digest|manifest/i,
    );
  });

  it('binds COMPLETE to the canonical journal tail and sealed provenance artifacts', async () => {
    const mismatched = await mkdtemp(join(tmpdir(), 'browserir-paired-tail-mismatch-'));
    temporaryDirectories.push(mismatched);
    const development = completeArtifacts();
    for (const [name, content] of Object.entries(development.artifacts)) {
      await writeFile(join(mismatched, name), content, 'utf8');
    }
    await writeFile(
      join(mismatched, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(development.artifacts),
      'utf8',
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(mismatched, {
        ...development.input,
        journalFinalEventSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/journal.*tail|final.*event|digest/i);
    await expect(readFile(join(mismatched, 'COMPLETE.json'), 'utf8')).rejects.toThrow();

    const missingBuild = await mkdtemp(join(tmpdir(), 'browserir-paired-missing-build-'));
    temporaryDirectories.push(missingBuild);
    const sealed = completeArtifacts('sealed');
    delete sealed.artifacts['build-provenance-end.json'];
    for (const [name, content] of Object.entries(sealed.artifacts)) {
      await writeFile(join(missingBuild, name), content, 'utf8');
    }
    await writeFile(
      join(missingBuild, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(sealed.artifacts),
      'utf8',
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(missingBuild, sealed.input),
    ).rejects.toThrow(/build-provenance-end\.json|required artifact/i);
  });

  it('rejects a rehashed journal that claims completion without its scheduled block', async () => {
    const output = await mkdtemp(join(tmpdir(), 'browserir-paired-shortcut-'));
    temporaryDirectories.push(output);
    const { artifacts, input } = completeArtifacts('development', 'shortcut');
    for (const [name, content] of Object.entries(artifacts)) {
      await writeFile(join(output, name), content, 'utf8');
    }
    await writeFile(
      join(output, 'SHA256SUMS'),
      renderAgentBenchmarkChecksums(artifacts),
      'utf8',
    );

    await expect(
      createPairedAgentBenchmarkCompletionMarker(output, input),
    ).rejects.toThrow(/journal|schedule|block|completed/i);
    await expect(readFile(join(output, 'COMPLETE.json'), 'utf8')).rejects.toThrow();
  });

  it('rejects drifted or malformed environment endpoints and their execution binding', async () => {
    const drifted = completeArtifacts();
    const changedEnvironment = executionEnvironment();
    changedEnvironment.host.hardware.logicalCpuCount = 12;
    drifted.artifacts['environment-end.json'] =
      renderPairedExecutionEnvironment(changedEnvironment);
    const driftedOutput = await materializeArtifacts(
      'browserir-paired-environment-drift-',
      drifted.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(driftedOutput, drifted.input),
    ).rejects.toThrow(/environment.*drift|drift.*environment/i);

    const malformed = completeArtifacts();
    malformed.artifacts['environment-end.json'] = '{"snapshot":"end"}\n';
    const malformedOutput = await materializeArtifacts(
      'browserir-paired-environment-malformed-',
      malformed.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(malformedOutput, malformed.input),
    ).rejects.toThrow(/environment.*invalid|invalid.*environment/i);

    const bindingMismatch = completeArtifacts();
    const bindingExecution = JSON.parse(
      bindingMismatch.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    bindingExecution['environment'] = {
      ...(bindingExecution['environment'] as Record<string, unknown>),
      bindingSha256: '0'.repeat(64),
    };
    bindingMismatch.artifacts['execution.json'] = prettyStableJson(bindingExecution);
    const bindingOutput = await materializeArtifacts(
      'browserir-paired-environment-binding-',
      bindingMismatch.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(bindingOutput, bindingMismatch.input),
    ).rejects.toThrow(/environment binding.*differ/i);
  });

  it('rejects drifted or malformed sealed build-provenance endpoints', async () => {
    const drifted = completeArtifacts('sealed');
    drifted.artifacts['build-provenance-end.json'] = renderSealedBuildProvenance(
      sealedBuildProvenance('changed'),
    );
    const driftedOutput = await materializeArtifacts(
      'browserir-paired-build-drift-',
      drifted.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(driftedOutput, drifted.input),
    ).rejects.toThrow(/build.*drift|content changed|provenance changed/i);

    const malformed = completeArtifacts('sealed');
    malformed.artifacts['build-provenance-end.json'] = '{"build":"end"}\n';
    const malformedOutput = await materializeArtifacts(
      'browserir-paired-build-malformed-',
      malformed.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(malformedOutput, malformed.input),
    ).rejects.toThrow(/build provenance.*invalid|invalid sealed build provenance/i);

    const bindingMismatch = completeArtifacts('sealed');
    const bindingExecution = JSON.parse(
      bindingMismatch.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    bindingExecution['buildProvenance'] = {
      ...(bindingExecution['buildProvenance'] as Record<string, unknown>),
      startSha256: '0'.repeat(64),
    };
    bindingMismatch.artifacts['execution.json'] = prettyStableJson(bindingExecution);
    const bindingOutput = await materializeArtifacts(
      'browserir-paired-build-binding-',
      bindingMismatch.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(bindingOutput, bindingMismatch.input),
    ).rejects.toThrow(/build provenance binding.*differ/i);
  });

  it('rejects execution source and tool-catalog cross-link drift', async () => {
    const sourceDrift = completeArtifacts();
    const execution = JSON.parse(sourceDrift.artifacts['execution.json']!) as Record<
      string,
      unknown
    >;
    execution['source'] = {
      ...(execution['source'] as Record<string, unknown>),
      clean: true,
    };
    sourceDrift.artifacts['execution.json'] = prettyStableJson(execution);
    const sourceOutput = await materializeArtifacts(
      'browserir-paired-source-drift-',
      sourceDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(sourceOutput, sourceDrift.input),
    ).rejects.toThrow(/source.*differ|source.*mismatch|source.*drift/i);

    const sealedSourceDrift = completeArtifacts('sealed');
    const sealedExecution = JSON.parse(
      sealedSourceDrift.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    sealedExecution['sourceEnd'] = {
      ...(sealedExecution['sourceEnd'] as Record<string, unknown>),
      freezeRef: 'different-freeze-ref',
    };
    sealedSourceDrift.artifacts['execution.json'] = prettyStableJson(sealedExecution);
    const sealedSourceOutput = await materializeArtifacts(
      'browserir-paired-sealed-source-drift-',
      sealedSourceDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        sealedSourceOutput,
        sealedSourceDrift.input,
      ),
    ).rejects.toThrow(/source freezeRef.*drift/i);

    const catalogDrift = completeArtifacts();
    catalogDrift.artifacts['control-tool-catalog.json'] = prettyStableJson([
      ...modelFacingCatalog('control'),
      {
        name: 'browser_click',
        description: 'Click a target.',
        inputSchema: { type: 'object' },
      },
    ]);
    const catalogOutput = await materializeArtifacts(
      'browserir-paired-catalog-drift-',
      catalogDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(catalogOutput, catalogDrift.input),
    ).rejects.toThrow(/catalog.*digest|catalog.*count|tool.*catalog/i);

    const catalogBindingDrift = completeArtifacts();
    const catalogExecution = JSON.parse(
      catalogBindingDrift.artifacts['execution.json']!,
    ) as Record<string, unknown>;
    const finalCatalogs = catalogExecution['toolCatalogs'] as Record<
      string,
      Record<string, unknown>
    >;
    finalCatalogs['control'] = {
      ...finalCatalogs['control'],
      toolCount: 2,
    };
    catalogBindingDrift.artifacts['execution.json'] = prettyStableJson(catalogExecution);
    const catalogBindingOutput = await materializeArtifacts(
      'browserir-paired-catalog-binding-drift-',
      catalogBindingDrift.artifacts,
    );
    await expect(
      createPairedAgentBenchmarkCompletionMarker(
        catalogBindingOutput,
        catalogBindingDrift.input,
      ),
    ).rejects.toThrow(/execution tool catalogs.*differ/i);
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
