import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT,
  PLAYWRIGHT_MCP_VERSION,
  readControlCapabilityProtocol,
} from '../src/agent-benchmark/index.js';

const manifestPath = fileURLToPath(
  new URL('../../../docs/evidence-drops/drop-01/control-capability-v1.protocol.json', import.meta.url),
);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

describe('frozen control capability manifest', () => {
  it('binds the current excluded task, neutral prompt, target, and official control', async () => {
    const { protocol } = await readControlCapabilityProtocol(manifestPath);
    const [task] = fixtureAgentTasks([protocol.task.id]);

    expect(task).toBeDefined();
    expect(protocol).toMatchObject({
      purpose: 'control_capability_qualification',
      scoreEligible: false,
      status: 'frozen',
      schedule: {
        attempts: 5,
        stoppingRule: 'run-entire-schedule',
        invalidReplacementPolicy: 'none',
      },
      decisionRule: {
        id: 'complete-five-zero-invalid-at-least-one-pass',
        requiredCompletedAttempts: 5,
        maximumInvalidAttempts: 0,
        minimumPasses: 1,
      },
      agent: {
        framework: 'langchain-create-agent',
        frameworkVersion: '1.5.5',
        maxOutputTokens: 4096,
      },
      target: { expectedVersion: fixtureAgentTargetVersion(), headless: true },
      control: {
        id: 'playwright-mcp',
        package: '@playwright/mcp',
        interfaceVersion: PLAYWRIGHT_MCP_VERSION,
      },
    });
    expect(protocol.reservedSealedTaskIds).toContain('validation-recovery');
    expect(protocol.task.id).not.toBe('validation-recovery');
    expect(protocol.task.version).toBe(task!.version);
    expect(protocol.task.promptSha256).toBe(sha256(task!.prompt));
    expect(protocol.agent.systemPrompt).toBe(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT);
    expect(protocol.agent.systemPromptSha256).toBe(
      sha256(NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT),
    );
  });
});
