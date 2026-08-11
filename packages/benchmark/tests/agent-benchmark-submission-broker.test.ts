import { describe, expect, it } from 'vitest';

import {
  createSubmissionBroker,
  type AgentSubmissionContract,
  type AgentToolBroker,
} from '../src/agent-benchmark/index.js';

class EmptyBroker implements AgentToolBroker {
  async listTools() {
    return [];
  }
  async callTool() {
    return { text: 'inner', isError: false };
  }
  metrics() {
    return { calls: 0, errors: 0, byTool: {}, budgetExceeded: false };
  }
  async close() {}
}

const contract: AgentSubmissionContract = {
  description: 'Submit the customer number.',
  inputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
  validateInput(input) {
    return typeof input['answer'] === 'string' ? undefined : 'answer must be a string';
  },
};

describe('trusted benchmark submission broker', () => {
  it('advertises one generic tool and records a validated structured result', async () => {
    const tracked = createSubmissionBroker(new EmptyBroker(), contract);
    expect(await tracked.broker.listTools()).toContainEqual(
      expect.objectContaining({ name: 'benchmark_submit_result', inputSchema: contract.inputSchema }),
    );
    await expect(
      tracked.broker.callTool('benchmark_submit_result', { answer: 'K-100042' }),
    ).resolves.toMatchObject({ isError: false });
    expect(tracked.state()).toEqual({
      attempts: 1,
      submitted: true,
      result: { answer: 'K-100042' },
    });
    expect(tracked.broker.metrics()).toMatchObject({
      calls: 1,
      errors: 0,
      byTool: { benchmark_submit_result: 1 },
    });
  });

  it('rejects invalid and duplicate submissions deterministically', async () => {
    const tracked = createSubmissionBroker(new EmptyBroker(), contract);
    await expect(
      tracked.broker.callTool('benchmark_submit_result', {}),
    ).resolves.toMatchObject({ isError: true });
    await tracked.broker.callTool('benchmark_submit_result', { answer: 'K-100042' });
    await expect(
      tracked.broker.callTool('benchmark_submit_result', { answer: 'K-999999' }),
    ).resolves.toMatchObject({ isError: true });
    expect(tracked.state()).toEqual({
      attempts: 3,
      submitted: true,
      result: { answer: 'K-100042' },
    });
    expect(tracked.broker.metrics()).toMatchObject({ calls: 3, errors: 2 });
  });
});
