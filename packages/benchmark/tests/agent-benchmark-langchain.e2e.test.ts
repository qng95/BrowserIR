import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import {
  createFixtureAgentTargetFactory,
  createLangChainBrowserAgent,
  fixtureAgentTargetVersion,
  fixtureAgentTasks,
  runAgentBenchmark,
} from '../src/agent-benchmark/index.js';

type ToolCall = { name: string; args: Record<string, unknown>; id: string };

const lastToolText = (messages: BaseMessage[]): string => {
  const message = [...messages].reverse().find((candidate) => candidate._getType() === 'tool');
  if (message === undefined) throw new Error('Expected a preceding BrowserIR tool result.');
  return message.text;
};

const toolTextsNewestFirst = (messages: BaseMessage[]): string[] =>
  [...messages]
    .reverse()
    .filter((candidate) => candidate._getType() === 'tool')
    .map((message) => message.text);

const envelope = (messages: BaseMessage[]): Record<string, unknown> => {
  const text = lastToolText(messages);
  const marker = 'Structured tool content:\n';
  const start = text.lastIndexOf(marker);
  if (start < 0) throw new Error(`Missing structured BrowserIR content:\n${text}`);
  return JSON.parse(text.slice(start + marker.length)) as Record<string, unknown>;
};

const stringField = (value: Record<string, unknown>, field: string): string => {
  const found = value[field];
  if (typeof found !== 'string') throw new Error(`Missing string ${field}.`);
  return found;
};

const numberField = (value: Record<string, unknown>, field: string): number => {
  const found = value[field];
  if (typeof found !== 'number') throw new Error(`Missing number ${field}.`);
  return found;
};

const entityRef = (messages: BaseMessage[], expectedName: string) => {
  for (const text of toolTextsNewestFirst(messages)) {
    for (const line of text.split('\n')) {
      const match = /^\[([^@\]]+)@r(\d+)\].*\bname=("(?:\\.|[^"\\])*")/u.exec(line);
      if (match === null || JSON.parse(match[3]!) !== expectedName) continue;
      const data = envelope(messages);
      return {
        page_id: stringField(data, 'page_id'),
        entity_id: match[1]!,
        // Delta-first receipts deliberately omit an unchanged full view. The
        // deterministic model mirrors a real conversation by retaining the
        // latest observed ref; BrowserIR alone decides whether its identity can
        // be safely rebound across every intervening revision.
        revision: Number(match[2]),
      };
    }
  }
  throw new Error(`Could not find BrowserIR entity named ${JSON.stringify(expectedName)}.`);
};

const toolMessage = (call: ToolCall): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ ...call, type: 'tool_call' }] });

const toolFactory = (
  index: number,
  create: (messages: BaseMessage[]) => Omit<ToolCall, 'id'>,
) => (messages: BaseMessage[]): AIMessage =>
  toolMessage({ ...create(messages), id: `reference-${index}` });

const actionFactory = (
  index: number,
  kind: 'click' | 'fill',
  name: string,
  value?: string,
) =>
  toolFactory(index, (messages) => {
    const data = envelope(messages);
    return {
      name: 'browser_act',
      args: {
        browser_id: stringField(data, 'browser_id'),
        page_id: stringField(data, 'page_id'),
        expected_revision:
          typeof data['revision'] === 'number'
            ? numberField(data, 'revision')
            : numberField(data, 'post_revision'),
        max_tokens: 4_000,
        action: {
          kind,
          target: entityRef(messages, name),
          ...(value === undefined ? {} : { value }),
        },
      },
    };
  });

function createCustomerReferenceModel() {
  return fakeModel()
    .respond(
      toolFactory(0, () => ({ name: 'browser_create', args: {} })),
    )
    .respond(
      toolFactory(1, (messages) => {
        const data = envelope(messages);
        const prompt = messages.map((message) => message.text).join('\n');
        const origin = /^Target origin: (.+)$/mu.exec(prompt)?.[1];
        if (origin === undefined) throw new Error('Missing target origin in model prompt.');
        return {
          name: 'browser_navigate',
          args: {
            browser_id: stringField(data, 'browser_id'),
            page_id: stringField(data, 'page_id'),
            expected_revision: numberField(data, 'revision'),
            url: `${origin}/app/login`,
            max_tokens: 4_000,
          },
        };
      }),
    )
    .respond(actionFactory(2, 'fill', 'Username', 'test'))
    .respond(actionFactory(3, 'fill', 'Password', 'test'))
    .respond(actionFactory(4, 'click', 'Sign in'))
    .respond(actionFactory(5, 'click', 'New customer'))
    .respond(actionFactory(6, 'fill', 'Customer name', 'Steinweg Logistik GmbH'))
    .respond(actionFactory(7, 'fill', 'City', 'Leipzig'))
    .respond(actionFactory(8, 'fill', 'Country', 'Germany'))
    .respond(actionFactory(9, 'fill', 'Credit limit (€)', '30000'))
    .respond(actionFactory(10, 'fill', 'VAT ID', 'DE145879632'))
    .respond(actionFactory(11, 'click', 'Create customer'))
    .respond(
      toolFactory(12, () => ({ name: 'benchmark_submit_result', args: {} })),
    )
    .respond(new AIMessage('Completed through BrowserIR.'));
}

describe('LangChain agent benchmark vertical slice', () => {
  it(
    'drives a fresh real browser through MCP and passes only the sealed database/audit oracle',
    async () => {
      const fixture = {
        seed: 20260728,
        customers: 50,
        vehicles: 50,
        apiLatencyMs: 0,
        pageLatencyMs: 0,
      } as const;
      const report = await runAgentBenchmark({
        runId: 'langchain-reference-create-customer',
        tasks: fixtureAgentTasks(['create-customer']),
        trialsPerTask: 1,
        expectedTargetVersion: fixtureAgentTargetVersion(fixture),
        budgets: { maxDurationMs: 45_000, maxToolCalls: 16, maxModelTurns: 16 },
        targetFactory: createFixtureAgentTargetFactory({ fixture, headless: true }),
        agentFactory: async () =>
          createLangChainBrowserAgent({
            model: createCustomerReferenceModel(),
            modelId: 'langchain-deterministic-reference-model',
          }),
      });

      expect(report.summary).toMatchObject({ passed: 1, failed: 0, invalid: 0 });
      expect(report.trials[0]).toMatchObject({
        outcome: 'passed',
        submissionAttempts: 1,
        judge: { outcome: 'passed' },
        tools: {
          calls: 13,
          errors: 0,
          byTool: { benchmark_submit_result: 1 },
          policyViolations: [],
        },
      });
    },
    60_000,
  );
});
