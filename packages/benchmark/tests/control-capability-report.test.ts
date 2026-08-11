import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentTrialResult } from '../src/agent-benchmark/contracts.js';
import { deterministicModelSeed } from '../src/agent-benchmark/paired-model-seed.js';
import type { ControlCapabilityProtocol } from '../src/agent-benchmark/control-capability-protocol.js';
import {
  createControlCapabilityReport,
  renderControlCapabilityAttemptsNdjson,
  renderControlCapabilityJson,
  renderControlCapabilityMarkdown,
  writeControlCapabilityArtifacts,
} from '../src/agent-benchmark/control-capability-report.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const systemPrompt = 'Use the browser tools.';
const protocol: ControlCapabilityProtocol = {
  schemaVersion: '1.0.0',
  purpose: 'control_capability_qualification',
  scoreEligible: false,
  status: 'frozen',
  dropId: '01',
  protocolId: 'control-capability-v1',
  task: {
    id: 'create-customer',
    version: `sha256:${'1'.repeat(64)}`,
    promptSha256: '2'.repeat(64),
    oracleVersion: `sha256:${'3'.repeat(64)}`,
  },
  reservedSealedTaskIds: ['validation-recovery'],
  schedule: {
    attempts: 5,
    modelSeedBase: 1234,
    stoppingRule: 'run-entire-schedule',
    invalidReplacementPolicy: 'none',
  },
  decisionRule: {
    id: 'complete-five-zero-invalid-at-least-one-pass',
    requiredCompletedAttempts: 5,
    maximumInvalidAttempts: 0,
    minimumPasses: 1,
  },
  budgets: { maxDurationMs: 300_000, maxToolCalls: 100, maxModelTurns: 30 },
  agent: {
    framework: 'langchain-create-agent',
    frameworkVersion: '1.5.5',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    modelId: 'qwen/qwen3.8-max',
    canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
    modelMetadataSha256: '4'.repeat(64),
    providerRoute: 'alibaba',
    reasoningEffort: 'low',
    providerPolicy: {
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    },
    modelCapabilities: { tools: true, seed: true, temperature: true },
    temperature: 0.2,
    maxOutputTokens: 4096,
    maxRetries: 0,
    imageMode: 'text-only',
    systemPrompt,
    systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
  },
  target: { expectedVersion: `sha256:${'5'.repeat(64)}`, headless: true },
  control: {
    role: 'control',
    id: 'playwright-mcp',
    package: '@playwright/mcp',
    label: 'Official Playwright MCP',
    interfaceVersion: '0.0.78',
    expectedToolCatalogSha256: '6'.repeat(64),
  },
};

const sentinel = 'PRIVATE-PAGE-TEXT-91742';

const attempt = (
  trialIndex: number,
  outcome: AgentTrialResult['outcome'],
): AgentTrialResult => ({
  attemptId: `capability-run:create-customer:${trialIndex}`,
  taskId: protocol.task.id,
  taskVersion: protocol.task.version,
  trialIndex,
  outcome,
  ...(outcome === 'failed' ? { failureKind: 'oracle_failed' } : {}),
  ...(outcome === 'invalid' ? { failureKind: 'target_setup_failed' } : {}),
  targetId: 'fixture:create-customer',
  targetVersion: protocol.target.expectedVersion,
  agentStatus: outcome === 'invalid' ? 'not_started' : 'completed',
  ...(outcome === 'invalid' ? { agentError: sentinel } : {}),
  finalText: sentinel,
  submittedResult: { secret: sentinel },
  submissionAttempts: outcome === 'passed' ? 1 : 0,
  modelTurns: outcome === 'invalid' ? 0 : 8,
  durationMs: 1_000 + trialIndex,
  tools: {
    calls: outcome === 'invalid' ? 0 : 8,
    errors: 0,
    byTool: { browser_snapshot: 1 },
    budgetExceeded: false,
    policyViolations: [],
    ...(outcome === 'invalid'
      ? {}
      : {
          toolCatalogSha256: protocol.control.expectedToolCatalogSha256,
          toolCatalogToolCount: 17,
          responseBytes: 2000,
          screenshots: 0,
          dispatchedBrowserActions: 3,
        }),
  },
  baseline: {
    outcome: 'failed',
    oracleVersion: protocol.task.oracleVersion,
    stateFingerprint: '7'.repeat(64),
    criteria: [
      {
        id: 'database-and-audit-oracle',
        required: true,
        passed: false,
        description: sentinel,
        evidence: sentinel,
      },
    ],
  },
  judge: {
    outcome,
    oracleVersion: protocol.task.oracleVersion,
    stateFingerprint: '8'.repeat(64),
    criteria: [
      {
        id: 'database-and-audit-oracle',
        required: true,
        passed: outcome === 'passed',
        description: sentinel,
        evidence: sentinel,
      },
    ],
    reason: sentinel,
  },
  agent: {
    adapterId:
      outcome === 'invalid' ? 'not-started' : 'control-capability-langchain-agent',
    framework: outcome === 'invalid' ? 'none' : protocol.agent.framework,
    frameworkVersion:
      outcome === 'invalid' ? 'none' : protocol.agent.frameworkVersion,
    model: outcome === 'invalid' ? 'none' : protocol.agent.modelId,
    ...(outcome === 'invalid'
      ? {}
      : {
          modelConfiguration: {
            provider: protocol.agent.provider,
            modelId: protocol.agent.modelId,
            temperature: protocol.agent.temperature,
            maxOutputTokens: protocol.agent.maxOutputTokens,
            maxRetries: protocol.agent.maxRetries,
            imageMode: protocol.agent.imageMode,
            seed: deterministicModelSeed(
              protocol.schedule.modelSeedBase,
              protocol.task.id,
              trialIndex,
            ),
            ...(protocol.agent.provider === 'openrouter'
              ? {
                  canonicalModelSlug: protocol.agent.canonicalModelSlug,
                  modelMetadataSha256: protocol.agent.modelMetadataSha256,
                  providerRoute: protocol.agent.providerRoute,
                  reasoningEffort: protocol.agent.reasoningEffort,
                  providerPolicy: { ...protocol.agent.providerPolicy },
                }
              : {
                  modelDigest: protocol.agent.modelDigest,
                  contextWindowTokens: protocol.agent.contextWindowTokens,
                }),
          },
        }),
    systemPromptSha256: protocol.agent.systemPromptSha256,
  },
});

const createReport = (outcomes: AgentTrialResult['outcome'][]) =>
  createControlCapabilityReport({
    runId: 'capability-run',
    protocol,
    protocolSha256: '9'.repeat(64),
    attempts: outcomes.map((outcome, index) => attempt(index, outcome)),
  });

describe('control capability report', () => {
  it('demonstrates capability only after the complete five-attempt schedule passes at least once', () => {
    const demonstrated = createReport(['failed', 'passed', 'failed', 'failed', 'failed']);
    expect(demonstrated.result).toEqual({
      status: 'demonstrated',
      scheduledAttempts: 5,
      completedAttempts: 5,
      minimumPasses: 1,
      maximumInvalidAttempts: 0,
      passed: 1,
      failed: 4,
      invalid: 0,
    });

    expect(createReport(['failed', 'failed', 'failed', 'failed', 'failed']).result.status)
      .toBe('not_demonstrated');
    expect(createReport(['passed']).result.status).toBe('operationally_inconclusive');
    expect(createReport(['passed', 'failed', 'failed', 'failed', 'invalid']).result.status)
      .toBe('operationally_inconclusive');
  });

  it('publishes raw counts without pass rates, intervals, uplift, or private content', () => {
    const report = createReport(['failed', 'passed', 'failed', 'failed', 'failed']);
    const rendered = [
      renderControlCapabilityJson(report),
      renderControlCapabilityAttemptsNdjson(report),
      renderControlCapabilityMarkdown(report),
    ].join('\n');

    expect(rendered).not.toContain(sentinel);
    expect(rendered).not.toMatch(/passRate|confidence|interval|uplift/i);
    expect(rendered).toContain('SCORE-EXCLUDED');
    expect(rendered).toContain('1 passed, 4 failed, 0 invalid');
    expect(JSON.parse(renderControlCapabilityJson(report))).toMatchObject({
      purpose: 'control_capability_qualification',
      scoreEligible: false,
      binding: { decisionRule: protocol.decisionRule },
      result: { status: 'demonstrated', passed: 1, failed: 4, invalid: 0 },
    });
  });

  it('rejects schedule, task, target, catalog, and model drift', () => {
    expect(() => createReport(['passed', 'failed', 'failed', 'failed', 'failed', 'failed']))
      .toThrow(/schedule/i);

    const wrongTask = attempt(0, 'passed');
    wrongTask.taskId = 'other-task';
    expect(() =>
      createControlCapabilityReport({
        runId: 'wrong-task',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [wrongTask],
      }),
    ).toThrow(/task/i);

    const wrongTarget = attempt(0, 'passed');
    wrongTarget.targetVersion = `sha256:${'a'.repeat(64)}`;
    expect(() =>
      createControlCapabilityReport({
        runId: 'wrong-target',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [wrongTarget],
      }),
    ).toThrow(/target/i);

    const wrongCatalog = attempt(0, 'passed');
    wrongCatalog.tools.toolCatalogSha256 = 'b'.repeat(64);
    expect(() =>
      createControlCapabilityReport({
        runId: 'wrong-catalog',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [wrongCatalog],
      }),
    ).toThrow(/catalog/i);

    const wrongModel = attempt(0, 'passed');
    wrongModel.agent.model = 'other/model';
    expect(() =>
      createControlCapabilityReport({
        runId: 'wrong-model',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [wrongModel],
      }),
    ).toThrow(/model/i);
  });

  it('rejects attempts that are not owned by the declared run', () => {
    const foreignAttempt = attempt(0, 'passed');
    foreignAttempt.attemptId = 'another-run:create-customer:0';

    expect(() =>
      createControlCapabilityReport({
        runId: 'capability-run',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [foreignAttempt],
      }),
    ).toThrow(/attempt.*run|attempt.*identity/i);
  });

  it('rejects a claimed pass without complete, internally consistent judge evidence', () => {
    const reportFrom = (candidate: AgentTrialResult) =>
      createControlCapabilityReport({
        runId: 'capability-run',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [candidate],
      });

    const missingBaseline = attempt(0, 'passed');
    delete missingBaseline.baseline;
    expect(() => reportFrom(missingBaseline)).toThrow(/baseline/i);

    const missingFinalJudge = attempt(0, 'passed');
    delete missingFinalJudge.judge;
    expect(() => reportFrom(missingFinalJudge)).toThrow(/final judge/i);

    const notStarted = attempt(0, 'passed');
    notStarted.agentStatus = 'not_started';
    expect(() => reportFrom(notStarted)).toThrow(/passed.*completed|completed.*pass/i);

    const failedFinalJudge = attempt(0, 'passed');
    failedFinalJudge.judge!.outcome = 'failed';
    expect(() => reportFrom(failedFinalJudge)).toThrow(/passed final judge/i);

    const failedCriterion = attempt(0, 'passed');
    failedCriterion.judge!.criteria[0]!.passed = false;
    expect(() => reportFrom(failedCriterion)).toThrow(/criteria/i);

    const missingSubmission = attempt(0, 'passed');
    missingSubmission.submissionAttempts = 0;
    delete missingSubmission.submittedResult;
    expect(() => reportFrom(missingSubmission)).toThrow(/submission/i);

    const passWithFailure = attempt(0, 'passed');
    passWithFailure.failureKind = 'oracle_failed';
    expect(() => reportFrom(passWithFailure)).toThrow(/passed.*failure kind|failure kind.*pass/i);
  });

  it('requires failed and invalid outcomes to retain failure kinds from their own class', () => {
    const reportFrom = (candidate: AgentTrialResult) =>
      createControlCapabilityReport({
        runId: 'capability-run',
        protocol,
        protocolSha256: '9'.repeat(64),
        attempts: [candidate],
      });

    const failedWithoutKind = attempt(0, 'failed');
    delete failedWithoutKind.failureKind;
    expect(() => reportFrom(failedWithoutKind)).toThrow(/failed.*failure kind|failure kind.*failed/i);

    const failedWithInvalidKind = attempt(0, 'failed');
    failedWithInvalidKind.failureKind = 'target_setup_failed';
    expect(() => reportFrom(failedWithInvalidKind)).toThrow(/failure kind.*failed|failed.*failure kind/i);

    const invalidWithoutKind = attempt(0, 'invalid');
    delete invalidWithoutKind.failureKind;
    expect(() => reportFrom(invalidWithoutKind)).toThrow(/invalid.*failure kind|failure kind.*invalid/i);

    const invalidWithFailureKind = attempt(0, 'invalid');
    invalidWithFailureKind.failureKind = 'oracle_failed';
    expect(() => reportFrom(invalidWithFailureKind)).toThrow(/failure kind.*invalid|invalid.*failure kind/i);
  });

  it('writes create-only artifacts and checksums every published file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browserir-control-capability-'));
    temporaryDirectories.push(root);
    const output = join(root, 'run');
    const report = createReport(['failed', 'passed', 'failed', 'failed', 'failed']);

    await writeControlCapabilityArtifacts(output, report, {
      'protocol.json': '{"frozen":true}\n',
    });
    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS',
      'attempts.ndjson',
      'control-capability.json',
      'protocol.json',
      'summary.md',
    ]);
    const checksums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
    for (const name of [
      'attempts.ndjson',
      'control-capability.json',
      'protocol.json',
      'summary.md',
    ]) {
      const content = await readFile(join(output, name));
      const digest = createHash('sha256').update(content).digest('hex');
      expect(checksums).toContain(`${digest}  ${name}`);
    }

    const collision = join(root, 'collision');
    await mkdir(collision);
    await writeFile(join(collision, 'summary.md'), 'keep me\n');
    await expect(writeControlCapabilityArtifacts(collision, report)).rejects.toThrow(
      /exist|collision/i,
    );
    expect(await readFile(join(collision, 'summary.md'), 'utf8')).toBe('keep me\n');
  });
});
