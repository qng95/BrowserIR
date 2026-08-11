import { describe, expect, it } from 'vitest';

import {
  inspectModelFacingCatalog,
  modelFacingToolCatalogSha256,
  type AgentBenchmarkTask,
  type AgentToolBroker,
  type AgentTrialTarget,
} from '../src/agent-benchmark/index.js';

const task: AgentBenchmarkTask = { id: 'catalog-task', prompt: 'Do it.' };

describe('evidence-drop catalog preflight', () => {
  it('hashes the exact model-facing catalog including trusted submission', async () => {
    let closed = 0;
    const tools: AgentToolBroker = {
      async listTools() {
        return [
          {
            name: 'browser_snapshot',
            description: 'Inspect the page.',
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        throw new Error('unused');
      },
      metrics() {
        return { calls: 0, errors: 0, byTool: {}, budgetExceeded: false };
      },
      async close() {
        closed += 1;
      },
    };
    const targetFactory = async (): Promise<AgentTrialTarget> => ({
      targetId: 'target',
      targetVersion: 'target-v1',
      origin: 'http://127.0.0.1:1234',
      tools,
      submission: {
        description: 'Confirm completion.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        validateInput: () => undefined,
      },
      async judge() {
        return {
          outcome: 'failed',
          oracleVersion: 'oracle-v1',
          stateFingerprint: 'baseline-v1',
          criteria: [],
        };
      },
      async stopAgentAccess() {},
      async dispose() {},
    });

    const snapshot = await inspectModelFacingCatalog({ task, targetFactory });

    expect(snapshot.catalog.map((tool) => tool.name)).toEqual([
      'browser_snapshot',
      'benchmark_submit_result',
    ]);
    expect(snapshot.sha256).toBe(modelFacingToolCatalogSha256(snapshot.catalog));
    expect(snapshot.toolCount).toBe(2);
    expect(closed).toBe(1);
  });

  it('rejects duplicate model-facing names', () => {
    expect(() =>
      modelFacingToolCatalogSha256([
        { name: 'same', description: 'one', inputSchema: {} },
        { name: 'same', description: 'two', inputSchema: {} },
      ]),
    ).toThrow(/duplicate/i);
  });
});
