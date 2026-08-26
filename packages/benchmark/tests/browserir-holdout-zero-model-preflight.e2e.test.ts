import { describe, expect, it } from 'vitest';

import { createOfficialBrowserIrHoldoutZeroModelDependencies } from
  '../src/agent-benchmark/browserir-holdout-zero-model-live.js';
import { runBrowserIrHoldoutZeroModelPreflight } from
  '../src/agent-benchmark/browserir-holdout-zero-model-preflight.js';

const optIn = process.env['BROWSERIR_RUN_HOLDOUT_ZERO_MODEL_PREFLIGHT'] === '1'
  ? it
  : it.skip;

describe('Browser IR holdout zero-model official Playwright MCP preflight', () => {
  optIn('runs all 64 fixed-origin arms and audits observed page requests without a holdout click', async () => {
    const result = await runBrowserIrHoldoutZeroModelPreflight(
      createOfficialBrowserIrHoldoutZeroModelDependencies({ headless: true }),
    );
    expect(result.status).toBe(
      'passed-zero-model-observed-loopback-page-requests-preflight',
    );
    expect(result.summary).toMatchObject({
      arms: 64,
      pairs: 32,
      observedUniqueFixtureProcessPids: 64,
      observedUniqueMcpProcessPids: 64,
      freshInMemoryDatabaseConstructionAttestations: 64,
      isolatedBrowserContextConstructionAttestations: 64,
      initialPageConstructionAttestations: 64,
      disabled: 32,
      passthrough: 16,
      hiddenCalls: 16,
      databaseMutations: 0,
      holdoutActionClicks: 0,
      modelCalls: 0,
      providerCalls: 0,
      observedExternalPageRequests: 0,
      paidCalls: 0,
      score: null,
      claimAuthority: false,
    });
    expect(result.summary.projected + result.summary.projectionUnresolved).toBe(16);
    expect(result.summary.safeFallbacks).toBe(result.summary.projectionUnresolved);
    expect(result.summary.projectionMisses +
      result.summary.unresolvedWithoutRecoverabilityProof)
      .toBe(result.summary.projectionUnresolved);
    expect(result.summary).toMatchObject({
      projected: 15,
      projectionUnresolved: 1,
      safeFallbacks: 1,
      demonstratedRecoverableRelations: 15,
      projectionMisses: 0,
      unresolvedWithoutRecoverabilityProof: 1,
      projectionRecallOnDemonstratedRecoverable: 1,
    });
    expect(result.summary.fixedLoopbackOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(result.summary.observedPageRequests).toBeGreaterThanOrEqual(128);
  }, 900_000);
});
