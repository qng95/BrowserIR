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

const drop01ManifestPath = fileURLToPath(
  new URL(
    '../../../docs/evidence-drops/drop-01/sealed-adaptive-v2.protocol.json',
    import.meta.url,
  ),
);
const drop02ManifestPath = fileURLToPath(
  new URL('../../../docs/evidence-drops/drop-02/sealed.protocol.json', import.meta.url),
);
const drop02SeedNamespace =
  'browserir-evidence-drop-02-qwen38max-query-three-conditions-v1';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const domainSeparatedSeed = (domain: 'order' | 'bootstrap' | 'model'): number =>
  createHash('sha256')
    .update(`${drop02SeedNamespace}:${domain}`, 'utf8')
    .digest()
    .readUInt32BE(0);

describe('Evidence Drop 02 frozen paired manifest', () => {
  it('binds the new workflow to the unchanged Drop 01 v2 agent and interfaces', async () => {
    const [{ protocol: drop01 }, manifest] = await Promise.all([
      readEvidenceDropProtocol(drop01ManifestPath),
      readEvidenceDropProtocol(drop02ManifestPath),
    ]);
    const { protocol } = manifest;
    const fixtureTask = taskById('query-three-conditions');
    const [benchmarkTask] = fixtureAgentTasks(['query-three-conditions']);

    expect(fixtureTask).toBeDefined();
    expect(benchmarkTask).toBeDefined();
    expect(manifest.sha256).toBe(
      'a3b2da51540f2784dab7d324977c30fb98ced1aabe9551746083725ee243d1a3',
    );
    expect(protocol).toMatchObject({
      dropId: '02',
      protocolId: 'drop-02-qwen38max-query-three-conditions-v1',
      phase: 'sealed',
      status: 'frozen',
      freezeRef: 'refs/tags/evidence-drop-02-protocol-v1',
      taskIds: ['query-three-conditions'],
      reservedSealedTaskIds: ['query-three-conditions'],
      trialsPerTask: 30,
      target: {
        expectedVersion:
          'sha256:5609bf1a1e9286c14a85eb8be641104f124b7e830e6b182789de6fcb9eb7fdec',
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
            '6257d7619f5ae3d5c4199fc2fb604cbde24886991519f173b503e75a2e64465e',
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
    expect(protocol).not.toHaveProperty('adaptiveLineage');
    expect(protocol.agent).toEqual(drop01.agent);
    expect(protocol.budgets).toEqual(drop01.budgets);
    expect(protocol.arms).toEqual(drop01.arms);
    expect(protocol.target.headless).toBe(drop01.target.headless);
    expect(protocol.target.expectedVersion).not.toBe(drop01.target.expectedVersion);
    expect(protocol.target.expectedVersion).toBe(fixtureAgentTargetVersion());
    expect(protocol.arms.control.interfaceVersion).toBe(PLAYWRIGHT_MCP_VERSION);
    expect(protocol.taskContracts).toEqual([
      {
        id: 'query-three-conditions',
        version: benchmarkTask!.version,
        promptSha256: sha256(fixtureTask!.prompt),
        oracleVersion: fixtureTask!.oracleVersion,
      },
    ]);
    expect(protocol.agent).toMatchObject({
      provider: 'openrouter',
      modelId: 'qwen/qwen3.8-max',
      canonicalModelSlug: 'qwen/qwen3.8-max-20260803',
      modelMetadataSha256:
        'aa4bc3cb2b4d668c5a67943f524dbb49a0da1bb31eb4b2811f2487959c05b901',
      providerRoute: 'alibaba',
      reasoningEffort: 'low',
      temperature: 0.2,
      maxOutputTokens: 4096,
      maxRetries: 0,
      imageMode: 'text-only',
    });
    expect(protocol.agent.systemPrompt).toBe(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT);
    expect(protocol.agent.systemPromptSha256).toBe(
      sha256(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT),
    );
  });

  it('uses a new domain-separated balanced schedule with 30 unique model seeds', async () => {
    const [{ protocol: drop01 }, { protocol: drop02 }] = await Promise.all([
      readEvidenceDropProtocol(drop01ManifestPath),
      readEvidenceDropProtocol(drop02ManifestPath),
    ]);
    const modelSeedBase = drop02.schedule.modelSeedBase;
    const drop01ModelSeedBase = drop01.schedule.modelSeedBase;
    expect(modelSeedBase).toBeDefined();
    expect(drop01ModelSeedBase).toBeDefined();

    expect(drop02.schedule).toMatchObject({
      orderSeed: domainSeparatedSeed('order'),
      bootstrapSeed: domainSeparatedSeed('bootstrap'),
      modelSeedBase: domainSeparatedSeed('model'),
      bootstrapResamples: 10_000,
      stoppingRule: 'run-entire-schedule',
      invalidReplacementPolicy: 'none',
    });
    expect(drop02.schedule.orderSeed).not.toBe(drop01.schedule.orderSeed);
    expect(drop02.schedule.bootstrapSeed).not.toBe(drop01.schedule.bootstrapSeed);
    expect(modelSeedBase).not.toBe(drop01ModelSeedBase);
    expect(drop02.schedule).not.toEqual(drop01.schedule);

    const orders = Array.from({ length: drop02.trialsPerTask }, (_, trialIndex) =>
      pairedArmOrder(
        drop02.schedule.orderSeed,
        'query-three-conditions',
        trialIndex,
      ),
    );
    const modelSeeds = Array.from(
      { length: drop02.trialsPerTask },
      (_, trialIndex) =>
        deterministicModelSeed(
          modelSeedBase!,
          'query-three-conditions',
          trialIndex,
        ),
    );
    const drop01ModelSeeds = new Set(
      Array.from({ length: drop01.trialsPerTask }, (_, trialIndex) =>
        deterministicModelSeed(
          drop01ModelSeedBase!,
          'validation-recovery',
          trialIndex,
        ),
      ),
    );

    expect(orders.filter(([first]) => first === 'control')).toHaveLength(15);
    expect(orders.filter(([first]) => first === 'treatment')).toHaveLength(15);
    expect(new Set(modelSeeds)).toHaveLength(30);
    expect(modelSeeds.filter((seed) => drop01ModelSeeds.has(seed))).toEqual([]);
  });

  it('matches the live no-model catalogs and failing baseline before the freeze', async () => {
    const { protocol } = await readEvidenceDropProtocol(drop02ManifestPath);
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
          headless: protocol.target.headless,
          toolBrokerFactory: controlBrokerFactory,
        }),
      }),
      inspectModelFacingCatalog({
        task: task!,
        targetFactory: createFixtureAgentTargetFactory({
          headless: protocol.target.headless,
        }),
      }),
    ]);

    expect(control.baseline.outcome).toBe('failed');
    expect(treatment.baseline.outcome).toBe('failed');
    expect(control.baseline.oracleVersion).toBe(protocol.taskContracts[0]!.oracleVersion);
    expect(treatment.baseline.oracleVersion).toBe(
      protocol.taskContracts[0]!.oracleVersion,
    );
    expect(control.baseline.stateFingerprint).toBe(
      treatment.baseline.stateFingerprint,
    );
    expect(control.sha256).toBe(protocol.arms.control.expectedToolCatalogSha256);
    expect(treatment.sha256).toBe(protocol.arms.treatment.expectedToolCatalogSha256);
    expect(control.toolCount).toBe(17);
    expect(treatment.toolCount).toBe(10);
    expect(control.targetVersion).toBe(protocol.target.expectedVersion);
    expect(treatment.targetVersion).toBe(protocol.target.expectedVersion);
  }, 30_000);
});
