import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import {
  NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT,
  createFixtureAgentTargetFactory,
  createLangChainBrowserAgent,
  createPlaywrightMcpToolBroker,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  runAgentBenchmark,
} from '../src/agent-benchmark/index.js';

type ToolCall = { name: string; args: Record<string, unknown>; id: string };

const lastToolText = (messages: BaseMessage[]): string => {
  const message = [...messages].reverse().find((candidate) => candidate._getType() === 'tool');
  if (message === undefined) throw new Error('Expected a preceding Playwright MCP result.');
  return message.text;
};

const snapshotTarget = (
  messages: BaseMessage[],
  name: string,
  role?: string,
): string => {
  const quoted = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expectedRole = role === undefined ? '[^\\s]+' : role;
  const pattern = new RegExp(
    `- ${expectedRole} "${quoted}"[^\\n]*\\[ref=([^\\]]+)\\]`,
    'u',
  );
  for (const message of [...messages].reverse()) {
    if (message._getType() !== 'tool') continue;
    const match = pattern.exec(message.text);
    if (match?.[1] !== undefined) return match[1];
  }
  {
    throw new Error(
      `Could not find Playwright MCP target named ${JSON.stringify(name)}:\n${lastToolText(messages)}`,
    );
  }
};

const toolMessage = (call: ToolCall): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ ...call, type: 'tool_call' }] });

const toolFactory = (
  index: number,
  create: (messages: BaseMessage[]) => Omit<ToolCall, 'id'>,
) => (messages: BaseMessage[]): AIMessage =>
  toolMessage({ ...create(messages), id: `playwright-reference-${index}` });

const targetAction = (
  index: number,
  name: string,
  toolName: 'browser_click' | 'browser_type',
  text?: string,
  role?: string,
) =>
  toolFactory(index, (messages) => ({
    name: toolName,
    args: {
      target: snapshotTarget(messages, name, role),
      element: name,
      ...(text === undefined ? {} : { text }),
    },
  }));

function createCustomerPlaywrightReferenceModel() {
  return fakeModel()
    .respond(
      toolFactory(0, (messages) => {
        const prompt = messages.map((message) => message.text).join('\n');
        const origin = /^Target origin: (.+)$/mu.exec(prompt)?.[1];
        if (origin === undefined) throw new Error('Missing target origin in model prompt.');
        return { name: 'browser_navigate', args: { url: `${origin}/app/login` } };
      }),
    )
    .respond(toolFactory(1, () => ({ name: 'browser_snapshot', args: {} })))
    .respond(targetAction(2, 'Username', 'browser_type', 'test'))
    .respond(targetAction(3, 'Password', 'browser_type', 'test'))
    .respond(targetAction(4, 'Sign in', 'browser_click', undefined, 'button'))
    .respond(toolFactory(5, () => ({ name: 'browser_snapshot', args: {} })))
    .respond(targetAction(6, 'New customer', 'browser_click', undefined, 'link'))
    .respond(toolFactory(7, () => ({ name: 'browser_snapshot', args: {} })))
    .respond(targetAction(8, 'Customer name', 'browser_type', 'Steinweg Logistik GmbH'))
    .respond(targetAction(9, 'City', 'browser_type', 'Leipzig'))
    .respond(targetAction(10, 'Country', 'browser_type', 'Germany'))
    .respond(targetAction(11, 'Credit limit (€)', 'browser_type', '30000'))
    .respond(targetAction(12, 'VAT ID', 'browser_type', 'DE145879632'))
    .respond(targetAction(13, 'Create customer', 'browser_click', undefined, 'button'))
    .respond(toolFactory(14, () => ({ name: 'benchmark_submit_result', args: {} })))
    .respond(new AIMessage('Completed through the browser interface.'));
}

describe('official Playwright MCP control vertical slice', () => {
  it(
    'uses the same fixture and sealed database/audit oracle as the BrowserIR arm',
    async () => {
      const fixture = {
        seed: 20260728,
        customers: 50,
        vehicles: 50,
        apiLatencyMs: 0,
        pageLatencyMs: 0,
      } as const;
      const report = await runAgentBenchmark({
        runId: 'playwright-mcp-reference-create-customer',
        tasks: fixtureAgentTasks(['create-customer']),
        trialsPerTask: 1,
        expectedTargetVersion: fixtureAgentTargetVersion(fixture),
        budgets: { maxDurationMs: 45_000, maxToolCalls: 18, maxModelTurns: 18 },
        targetFactory: createFixtureAgentTargetFactory({
          fixture,
          headless: true,
          toolBrokerFactory: ({ origin, headless, browserProfile }) =>
            createPlaywrightMcpToolBroker({
              allowedOrigin: origin,
              headless,
              viewport: browserProfile.viewport,
              locale: browserProfile.locale,
              timezoneId: browserProfile.timezoneId,
              colorScheme: browserProfile.colorScheme,
              reducedMotion: browserProfile.reducedMotion,
            }),
        }),
        agentFactory: async () =>
          createLangChainBrowserAgent({
            model: createCustomerPlaywrightReferenceModel(),
            modelId: 'langchain-deterministic-playwright-reference-model',
            systemPrompt: NEUTRAL_BROWSER_AGENT_SYSTEM_PROMPT,
          }),
      });

      expect(
        report.summary,
        JSON.stringify(report.trials[0], null, 2),
      ).toMatchObject({ passed: 1, failed: 0, invalid: 0 });
      expect(report.trials[0]).toMatchObject({
        outcome: 'passed',
        submissionAttempts: 1,
        judge: { outcome: 'passed' },
        tools: {
          calls: 15,
          errors: 0,
          byTool: { benchmark_submit_result: 1 },
          policyViolations: [],
        },
      });
    },
    60_000,
  );
});
