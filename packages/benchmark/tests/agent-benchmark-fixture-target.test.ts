import { createDb } from '@think-dom/fixture-app';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalDatabaseFingerprint,
  createFixtureAgentTargetFactory,
  fixtureAgentTasks,
  fixtureAgentTargetVersion,
  type AgentToolBroker,
} from '../src/agent-benchmark/index.js';

const fixture = {
  seed: 123,
  customers: 50,
  vehicles: 50,
  apiLatencyMs: 0,
  pageLatencyMs: 0,
} as const;

async function signIn(origin: string): Promise<string> {
  const response = await fetch(`${origin}/app/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test', password: 'test' }),
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  return /sid=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '';
}

async function post(
  origin: string,
  sid: string,
  path: string,
  form: Record<string, string>,
): Promise<void> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: `sid=${sid}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
}

async function createCustomer(origin: string, sid: string, name: string): Promise<void> {
  await post(origin, sid, '/app/customers/new', {
    name,
    city: name === 'Steinweg Logistik GmbH' ? 'Leipzig' : 'Berlin',
    country: 'Germany',
    status: 'Prospect',
    credit_limit: name === 'Steinweg Logistik GmbH' ? '30000' : '10000',
    vat_id: name === 'Steinweg Logistik GmbH' ? 'DE145879632' : '',
  });
}

const finalSubmission = {
  phase: 'final',
  submissionAttempts: 1,
  submitted: true,
  submittedResult: {},
} as const;

describe('isolated fixture agent target', () => {
  it('keeps the application and sealed judge identical when the browser interface is injected', async () => {
    const [task] = fixtureAgentTasks(['create-customer']);
    expect(task).toBeDefined();
    const broker = (): AgentToolBroker => ({
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error('unused');
      },
      metrics() {
        return { calls: 0, errors: 0, byTool: {}, budgetExceeded: false };
      },
      async close() {},
    });
    const leftFactory = vi.fn(async () => broker());
    const rightFactory = vi.fn(async () => broker());
    const left = await createFixtureAgentTargetFactory({
      fixture,
      headless: true,
      toolBrokerFactory: leftFactory,
    })(task!, 0);
    const right = await createFixtureAgentTargetFactory({
      fixture,
      headless: true,
      toolBrokerFactory: rightFactory,
    })(task!, 0);

    try {
      expect(left.targetVersion).toBe(right.targetVersion);
      expect(await left.judge()).toEqual(await right.judge());
      expect(leftFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          task: task!,
          trialIndex: 0,
          origin: left.origin,
          headless: true,
        }),
      );
      expect(rightFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          task: task!,
          trialIndex: 0,
          origin: right.origin,
          headless: true,
        }),
      );
    } finally {
      await left.dispose();
      await right.dispose();
    }
  });

  it('fingerprints identical seeded databases identically', () => {
    const left = createDb({ seed: 123, customers: 50, vehicles: 50 });
    const right = createDb({ seed: 123, customers: 50, vehicles: 50 });
    expect(canonicalDatabaseFingerprint(left)).toBe(canonicalDatabaseFingerprint(right));
    right.prepare("UPDATE customers SET city = 'Changed' WHERE id = 1").run();
    expect(canonicalDatabaseFingerprint(left)).not.toBe(canonicalDatabaseFingerprint(right));
    expect(fixtureAgentTargetVersion(fixture, true)).not.toBe(
      fixtureAgentTargetVersion(fixture, false),
    );
  });

  it('creates a fresh failing baseline for every attempt and seals access before final judging', async () => {
    const [task] = fixtureAgentTasks(['create-customer']);
    expect(task).toBeDefined();
    const options = { fixture, headless: true } as const;
    const factory = createFixtureAgentTargetFactory(options);
    const first = await factory(task!, 0);
    const second = await factory(task!, 1);

    try {
      expect(first.targetVersion).toBe(
        fixtureAgentTargetVersion(options.fixture, options.headless),
      );
      const firstBaseline = await first.judge();
      const secondBaseline = await second.judge();
      expect(firstBaseline.outcome).toBe('failed');
      expect(secondBaseline.outcome).toBe('failed');
      expect(firstBaseline.stateFingerprint).toBe(secondBaseline.stateFingerprint);

      await first.stopAgentAccess();
      await expect(fetch(`${first.origin}/app/login`)).rejects.toThrow();
      expect(await first.judge()).toEqual(await first.judge());
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('publishes task prompts and skills without exposing an oracle callback', () => {
    const tasks = fixtureAgentTasks();
    expect(tasks).toHaveLength(14);
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        prompt: expect.any(String),
        skills: expect.any(Array),
        version: expect.stringMatching(/^sha256:/),
      }),
    );
    expect(tasks.every((task) => !('verify' in task))).toBe(true);
  });

  it('rejects a correct task result with unrelated or repeated audited mutations', async () => {
    const [task] = fixtureAgentTasks(['create-customer']);
    expect(task).toBeDefined();
    const factory = createFixtureAgentTargetFactory({ fixture, headless: true });
    const correct = await factory(task!, 0);
    const unrelated = await factory(task!, 1);
    const repeated = await factory(task!, 2);

    try {
      const correctSid = await signIn(correct.origin);
      await createCustomer(correct.origin, correctSid, 'Steinweg Logistik GmbH');
      await correct.stopAgentAccess();
      const correctVerdict = await correct.judge(finalSubmission);
      expect(correctVerdict).toMatchObject({
        outcome: 'passed',
        criteria: expect.arrayContaining([
          expect.objectContaining({ id: 'no-collateral-audited-mutations', passed: true }),
        ]),
      });

      const unrelatedSid = await signIn(unrelated.origin);
      await createCustomer(unrelated.origin, unrelatedSid, 'Steinweg Logistik GmbH');
      await post(unrelated.origin, unrelatedSid, '/app/orders/1/deliver', {});
      const deliberatelyNonFreshBaseline = await unrelated.judge({
        phase: 'baseline',
        submissionAttempts: 0,
        submitted: false,
      });
      expect(deliberatelyNonFreshBaseline).toMatchObject({
        outcome: 'passed',
        criteria: [expect.objectContaining({ id: 'database-and-audit-oracle', passed: true })],
      });
      await unrelated.stopAgentAccess();
      const unrelatedVerdict = await unrelated.judge(finalSubmission);
      expect(unrelatedVerdict).toMatchObject({
        outcome: 'failed',
        criteria: expect.arrayContaining([
          expect.objectContaining({
            id: 'database-and-audit-oracle',
            passed: true,
          }),
          expect.objectContaining({
            id: 'no-collateral-audited-mutations',
            passed: false,
            evidence: expect.objectContaining({
              expectedActionCounts: { 'customer.create': 1 },
              actualActionCounts: { 'customer.create': 1, 'order.deliver': 1 },
            }),
          }),
        ]),
      });

      const repeatedSid = await signIn(repeated.origin);
      await createCustomer(repeated.origin, repeatedSid, 'Steinweg Logistik GmbH');
      await createCustomer(repeated.origin, repeatedSid, 'Collateral Customer GmbH');
      await repeated.stopAgentAccess();
      const repeatedVerdict = await repeated.judge(finalSubmission);
      expect(repeatedVerdict).toMatchObject({
        outcome: 'failed',
        criteria: expect.arrayContaining([
          expect.objectContaining({
            id: 'database-and-audit-oracle',
            passed: true,
          }),
          expect.objectContaining({
            id: 'no-collateral-audited-mutations',
            passed: false,
            evidence: expect.objectContaining({
              expectedActionCounts: { 'customer.create': 1 },
              actualActionCounts: { 'customer.create': 2 },
            }),
          }),
        ]),
      });
    } finally {
      await correct.dispose();
      await unrelated.dispose();
      await repeated.dispose();
    }
  });
});
