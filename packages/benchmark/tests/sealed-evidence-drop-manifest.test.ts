import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { taskById } from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import {
  createFixtureAgentTargetFactory,
  createPlaywrightMcpToolBroker,
  deterministicModelSeed,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  inspectModelFacingCatalog,
  NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT,
  pairedArmOrder,
  PLAYWRIGHT_MCP_VERSION,
  readEvidenceDropProtocol,
  type FixtureAgentToolBrokerFactoryInput,
} from '../src/agent-benchmark/index.js';

const manifestPath = fileURLToPath(
  new URL('../../../docs/evidence-drops/drop-01/sealed.protocol.json', import.meta.url),
);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('Evidence Drop 01 frozen paired manifest', () => {
  it('binds the reserved workflow, qualified model route, both interfaces, and public claim rule', async () => {
    const { protocol } = await readEvidenceDropProtocol(manifestPath);
    const fixtureTask = taskById('validation-recovery');
    const [benchmarkTask] = fixtureAgentTasks(['validation-recovery']);

    expect(fixtureTask).toBeDefined();
    expect(benchmarkTask).toBeDefined();
    expect(protocol).toMatchObject({
      dropId: '01',
      protocolId: 'drop-01-qwen38max-validation-recovery-v1',
      phase: 'sealed',
      status: 'frozen',
      freezeRef: 'refs/tags/evidence-drop-01-protocol-v1',
      taskIds: ['validation-recovery'],
      reservedSealedTaskIds: ['validation-recovery'],
      trialsPerTask: 30,
      schedule: {
        orderSeed: 20260811,
        bootstrapSeed: 141421,
        modelSeedBase: 20260812,
        bootstrapResamples: 10_000,
        stoppingRule: 'run-entire-schedule',
        invalidReplacementPolicy: 'none',
      },
      budgets: {
        maxDurationMs: 300_000,
        maxToolCalls: 100,
        maxModelTurns: 30,
      },
      agent: {
        framework: 'langchain-create-agent',
        frameworkVersion: '1.5.5',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        modelId: 'qwen/qwen3.8-max',
        canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
        modelMetadataSha256:
          'aa4bc3cb2b4d668c5a67943f524dbb49a0da1bb31eb4b2811f2487959c05b901',
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
      },
      target: { expectedVersion: fixtureAgentTargetVersion(), headless: true },
      arms: {
        control: {
          role: 'control',
          id: 'playwright-mcp',
          interfaceVersion: PLAYWRIGHT_MCP_VERSION,
          expectedToolCatalogSha256:
            '70b7709d1435f1345f92673ef395aea5b11f9a52189f8cba4c5be0ffc8719e75',
        },
        treatment: {
          role: 'treatment',
          id: 'browserir',
          interfaceVersion: '0.1.0+mcp-2026-07-28',
          expectedToolCatalogSha256:
            '1b13038b5650ccf5e283ffb3dcf81902845baeafb546fd6e6341ced7af821b34',
        },
      },
      analysis: {
        confidence: 0.95,
        interval: 'paired-hoeffding-bound',
        invalidBlockHeadlineThreshold: 0.05,
        primaryMetric: 'paired-treatment-minus-control-pass-rate',
        decisionRule: {
          minimumScheduledBlocks: 30,
          maximumInvalidBlocks: 1,
          positive: { lowerBoundAbove: 0 },
          negative: { upperBoundBelow: 0 },
          otherwise: 'inconclusive',
        },
        publicationRule: 'publish-regardless-of-sign',
        estimand: 'fixed-workflow-precommitted-seed-schedule',
      },
    });

    expect(protocol.question).toMatch(/complete browser interface/i);
    expect(protocol.arms.control.label).toMatch(/accessibility-snapshot/i);
    expect(protocol.taskContracts).toEqual([
      {
        id: 'validation-recovery',
        version: benchmarkTask!.version,
        promptSha256: sha256(fixtureTask!.prompt),
        oracleVersion: fixtureTask!.oracleVersion,
      },
    ]);
    expect(protocol.agent.systemPrompt).toBe(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT);
    expect(protocol.agent.systemPromptSha256).toBe(
      sha256(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT),
    );
  });

  it('counterbalances arm order and commits 30 unique model seeds before scoring', async () => {
    const { protocol } = await readEvidenceDropProtocol(manifestPath);
    const seedBase = protocol.schedule.modelSeedBase;
    expect(seedBase).toBeDefined();

    const orders = Array.from({ length: protocol.trialsPerTask }, (_, trialIndex) =>
      pairedArmOrder(protocol.schedule.orderSeed, 'validation-recovery', trialIndex),
    );
    const seeds = Array.from({ length: protocol.trialsPerTask }, (_, trialIndex) =>
      deterministicModelSeed(seedBase!, 'validation-recovery', trialIndex),
    );

    expect(orders.filter(([first]) => first === 'control')).toHaveLength(15);
    expect(orders.filter(([first]) => first === 'treatment')).toHaveLength(15);
    expect(new Set(seeds)).toHaveLength(30);
  });

  it('matches the live no-model catalogs and failing baseline before the freeze', async () => {
    const { protocol } = await readEvidenceDropProtocol(manifestPath);
    const [task] = fixtureAgentTasks(protocol.taskIds);
    expect(task).toBeDefined();
    const controlBrokerFactory = ({
      origin,
      headless,
      browserProfile,
    }: FixtureAgentToolBrokerFactoryInput) =>
      createPlaywrightMcpToolBroker({
        allowedOrigin: origin,
        headless,
        viewport: browserProfile.viewport,
        locale: browserProfile.locale,
        timezoneId: browserProfile.timezoneId,
        colorScheme: browserProfile.colorScheme,
        reducedMotion: browserProfile.reducedMotion,
      });
    const [control, treatment] = await Promise.all([
      inspectModelFacingCatalog({
        task: task!,
        targetFactory: createFixtureAgentTargetFactory({
          headless: true,
          toolBrokerFactory: controlBrokerFactory,
        }),
      }),
      inspectModelFacingCatalog({
        task: task!,
        targetFactory: createFixtureAgentTargetFactory({ headless: true }),
      }),
    ]);

    expect(control.baseline.outcome).toBe('failed');
    expect(treatment.baseline.outcome).toBe('failed');
    expect(control.baseline.stateFingerprint).toBe(treatment.baseline.stateFingerprint);
    expect(control.sha256).toBe(protocol.arms.control.expectedToolCatalogSha256);
    expect(treatment.sha256).toBe(protocol.arms.treatment.expectedToolCatalogSha256);
    expect(control.targetVersion).toBe(protocol.target.expectedVersion);
    expect(treatment.targetVersion).toBe(protocol.target.expectedVersion);
  }, 30_000);
});
