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
  parseEvidenceDropProtocol,
  PLAYWRIGHT_MCP_VERSION,
  readEvidenceDropProtocol,
  type FixtureAgentToolBrokerFactoryInput,
} from '../src/agent-benchmark/index.js';

const v1ManifestPath = fileURLToPath(
  new URL('../../../docs/evidence-drops/drop-01/sealed.protocol.json', import.meta.url),
);
const v2ManifestPath = fileURLToPath(
  new URL(
    '../../../docs/evidence-drops/drop-01/sealed-adaptive-v2.protocol.json',
    import.meta.url,
  ),
);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('Evidence Drop 01 frozen paired manifests', () => {
  it('preserves the v1 freeze as byte-bound historical evidence', async () => {
    const manifest = await readEvidenceDropProtocol(v1ManifestPath);

    expect(manifest.sha256).toBe(
      '038f84fa1ed12514e72e083166702cbae6646d492307fe49cfff959124c74c21',
    );
    expect(manifest.protocol).toMatchObject({
      dropId: '01',
      protocolId: 'drop-01-qwen38max-validation-recovery-v1',
      phase: 'sealed',
      status: 'frozen',
      freezeRef: 'refs/tags/evidence-drop-01-protocol-v1',
      taskIds: ['validation-recovery'],
      taskContracts: [
        {
          id: 'validation-recovery',
          version: 'sha256:17ef0329cef9a0634d531c3b3b46c68321906a0e84108f30a25a0fc8e0cccb17',
          promptSha256: '1fa6c1735774e4186ae1066640e1621316e811fe52e8aea3ae379791db082422',
          oracleVersion:
            'sha256:c9006e9100374dfeb28d0434111caa109c49424689b603dd100a1ddcd1ff7f10',
        },
      ],
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
        systemPromptSha256:
          '115b0e8d4f61a457c3961d4d26f8866c29a817e762539f7039bfb198ef7116cd',
      },
      target: {
        expectedVersion:
          'sha256:7d62e7e3e4ae0b02883d1606ca2e1eaad15a93d0dca6d582bf86c1525ca89364',
        headless: true,
      },
      arms: {
        control: {
          role: 'control',
          id: 'playwright-mcp',
          interfaceVersion: '0.0.78',
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
    expect(manifest.protocol).not.toHaveProperty('adaptiveLineage');
  });

  it('binds v2 as an adaptive recovery that changes only the treatment tool contract', async () => {
    const [{ protocol: v1 }, { protocol: v2 }] = await Promise.all([
      readEvidenceDropProtocol(v1ManifestPath),
      readEvidenceDropProtocol(v2ManifestPath),
    ]);
    const fixtureTask = taskById('validation-recovery');
    const [benchmarkTask] = fixtureAgentTasks(['validation-recovery']);

    expect(fixtureTask).toBeDefined();
    expect(benchmarkTask).toBeDefined();
    expect(v2).toMatchObject({
      dropId: '01',
      protocolId: 'drop-01-qwen38max-validation-recovery-adaptive-v2',
      phase: 'sealed',
      status: 'frozen',
      freezeRef: 'refs/tags/evidence-drop-01-protocol-v2',
      adaptiveLineage: {
        kind: 'adaptive-follow-up',
        predecessorProtocolId: 'drop-01-qwen38max-validation-recovery-v1',
        predecessorFreezeRef: 'refs/tags/evidence-drop-01-protocol-v1',
        trigger: 'observed-treatment-tool-contract-failure',
        schedulePolicy: 'reuse-predecessor-schedule-exactly',
        interpretation: 'adaptive-recovery-not-independent-confirmation',
      },
    });

    expect(v2.schemaVersion).toBe(v1.schemaVersion);
    expect(v2.dropId).toBe(v1.dropId);
    expect(v2.question).toBe(v1.question);
    expect(v2.taskIds).toEqual(v1.taskIds);
    expect(v2.taskContracts).toEqual(v1.taskContracts);
    expect(v2.reservedSealedTaskIds).toEqual(v1.reservedSealedTaskIds);
    expect(v2.trialsPerTask).toBe(v1.trialsPerTask);
    expect(v2.schedule).toEqual(v1.schedule);
    expect(v2.budgets).toEqual(v1.budgets);
    expect(v2.agent).toEqual(v1.agent);
    expect(v2.target).toEqual(v1.target);
    expect(v2.analysis).toEqual(v1.analysis);
    expect(v2.arms.control).toEqual(v1.arms.control);
    expect(v2.arms.treatment).toMatchObject({
      role: v1.arms.treatment.role,
      id: v1.arms.treatment.id,
      interfaceVersion: v1.arms.treatment.interfaceVersion,
    });
    expect(v2.arms.treatment.label).not.toBe(v1.arms.treatment.label);
    expect(v2.arms.treatment.expectedToolCatalogSha256).not.toBe(
      v1.arms.treatment.expectedToolCatalogSha256,
    );

    expect(v2.target.expectedVersion).toBe(fixtureAgentTargetVersion());
    expect(v2.arms.control.interfaceVersion).toBe(PLAYWRIGHT_MCP_VERSION);
    expect(v2.taskContracts).toEqual([
      {
        id: 'validation-recovery',
        version: benchmarkTask!.version,
        promptSha256: sha256(fixtureTask!.prompt),
        oracleVersion: fixtureTask!.oracleVersion,
      },
    ]);
    expect(v2.agent.systemPrompt).toBe(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT);
    expect(v2.agent.systemPromptSha256).toBe(
      sha256(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT),
    );
  });

  it('rejects undeclared adaptive-lineage fields', async () => {
    const { protocol } = await readEvidenceDropProtocol(v2ManifestPath);

    expect(() =>
      parseEvidenceDropProtocol({
        ...protocol,
        adaptiveLineage: {
          ...protocol.adaptiveLineage,
          undeclared: true,
        },
      }),
    ).toThrow(/adaptiveLineage.*unrecognized/i);
  });

  it('reuses the exact v1 arm order and 30 unique model seeds', async () => {
    const [{ protocol: v1 }, { protocol: v2 }] = await Promise.all([
      readEvidenceDropProtocol(v1ManifestPath),
      readEvidenceDropProtocol(v2ManifestPath),
    ]);
    const seedBase = v2.schedule.modelSeedBase;
    expect(seedBase).toBeDefined();

    const scheduleFor = (protocol: typeof v2) => ({
      orders: Array.from({ length: protocol.trialsPerTask }, (_, trialIndex) =>
        pairedArmOrder(protocol.schedule.orderSeed, 'validation-recovery', trialIndex),
      ),
      seeds: Array.from({ length: protocol.trialsPerTask }, (_, trialIndex) =>
        deterministicModelSeed(
          protocol.schedule.modelSeedBase!,
          'validation-recovery',
          trialIndex,
        ),
      ),
    });
    const v1Schedule = scheduleFor(v1);
    const v2Schedule = scheduleFor(v2);

    expect(v2Schedule).toEqual(v1Schedule);
    expect(v2Schedule.orders.filter(([first]) => first === 'control')).toHaveLength(15);
    expect(v2Schedule.orders.filter(([first]) => first === 'treatment')).toHaveLength(15);
    expect(new Set(v2Schedule.seeds)).toHaveLength(30);
  });

  it('matches v2 to the live no-model catalogs and failing baseline before the freeze', async () => {
    const { protocol } = await readEvidenceDropProtocol(v2ManifestPath);
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
