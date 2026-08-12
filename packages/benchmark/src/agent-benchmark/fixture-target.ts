import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  CUSTOMER_COUNT,
  DEFAULT_SEED,
  TASKS,
  VEHICLE_COUNT,
  startAppServer,
  taskById,
  type AppServerOptions,
} from '@think-dom/fixture-app';

import { stableJson } from '../environment.js';
import type {
  AgentBenchmarkTask,
  AgentSubmissionContract,
  AgentToolBroker,
  AgentTrialTarget,
  DeterministicJudgeInput,
  DeterministicJudgeResult,
} from './contracts.js';
import { createBrowserIrMcpToolBroker } from './mcp-broker.js';
import { pinBrowserProfile, restrictBrowserNavigation } from './policy-broker.js';

export const FIXTURE_AGENT_SUITE_VERSION = '1.4.0' as const;
export const FIXTURE_AUDIT_GUARD_VERSION = '1.0.0' as const;

export const DEFAULT_FIXTURE_AGENT_PROFILE = Object.freeze({
  seed: DEFAULT_SEED,
  customers: CUSTOMER_COUNT,
  vehicles: VEHICLE_COUNT,
  apiLatencyMs: 0,
  pageLatencyMs: 0,
});

export const FIXTURE_AGENT_BROWSER_PROFILE = Object.freeze({
  viewport: Object.freeze({ width: 1440, height: 900, deviceScaleFactor: 1 }),
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light' as const,
  reducedMotion: 'reduce' as const,
});

export interface FixtureAgentTargetOptions {
  fixture?: Readonly<
    Pick<AppServerOptions, 'seed' | 'customers' | 'vehicles' | 'apiLatencyMs' | 'pageLatencyMs'>
  >;
  headless?: boolean;
  toolBrokerFactory?: FixtureAgentToolBrokerFactory | undefined;
}

export interface FixtureAgentToolBrokerFactoryInput {
  task: AgentBenchmarkTask;
  trialIndex: number;
  origin: string;
  headless: boolean;
  browserProfile: typeof FIXTURE_AGENT_BROWSER_PROFILE;
}

export type FixtureAgentToolBrokerFactory = (
  input: FixtureAgentToolBrokerFactoryInput,
) => Promise<AgentToolBroker>;

interface NormalizedFixtureAgentProfile {
  seed: number;
  customers: number;
  vehicles: number;
  apiLatencyMs: number;
  pageLatencyMs: number;
}

type DatabaseRow = Record<string, unknown>;
type AuditCountSpec = number | 'first-draft-page';

const FIXTURE_AUDIT_ACTION_POLICIES: Readonly<Record<string, Readonly<Record<string, AuditCountSpec>>>> =
  Object.freeze({
    'create-customer': { 'customer.create': 1 },
    'raise-credit-limit': { 'customer.update': 1 },
    'validation-recovery': {
      'customer.create.rejected': 1,
      'customer.create': 1,
    },
    'mark-order-delivered': { 'order.deliver': 1 },
    'highest-revenue-poland': { 'customer.update': 1 },
    'reserve-cheapest-in-stock': { 'vehicle.status': 1 },
    'order-through-wizard': { 'order.create': 1, 'vehicle.reserve': 1 },
    'find-vin-deep-in-inventory': { 'vehicle.status': 1 },
    'bulk-cancel-drafts': {
      'order.cancel': 'first-draft-page',
      'order.bulk.cancel': 1,
    },
    'reschedule-appointment': { 'appointment.move': 1 },
    'restock-low-part': { 'part.restock': 1 },
    'settle-invoice': { 'invoice.pay': 1 },
    'triage-ticket': { 'ticket.update': 2 },
    'query-three-conditions': { 'report.query': 1 },
  });

interface FixtureAuditRow {
  id: number;
  action: string;
  entity: string;
  entity_id: string;
  detail: string | null;
}

interface AuditMutationGuardResult {
  passed: boolean;
  reason: string;
  evidence: {
    baselineAuditId: number;
    expectedActionCounts: Readonly<Record<string, number>>;
    actualActionCounts: Readonly<Record<string, number>>;
    auditDelta: readonly FixtureAuditRow[];
  };
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const auditActionPolicy = (taskId: string): Readonly<Record<string, AuditCountSpec>> => {
  const policy = FIXTURE_AUDIT_ACTION_POLICIES[taskId];
  if (policy === undefined) throw new Error(`Missing fixture audit action policy for ${taskId}.`);
  return policy;
};

function expectedAuditActionCounts(
  db: DatabaseSync,
  taskId: string,
): Readonly<Record<string, number>> {
  const firstDraftPageCount = Number(
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT id FROM orders
           WHERE status = 'Draft'
           ORDER BY placed_on DESC, id DESC
           LIMIT 25
         )`,
      )
      .get() as DatabaseRow)['n'],
  );
  return Object.fromEntries(
    Object.entries(auditActionPolicy(taskId)).map(([action, count]) => [
      action,
      count === 'first-draft-page' ? firstDraftPageCount : count,
    ]),
  );
}

function evaluateAuditMutationGuard(
  db: DatabaseSync,
  baselineAuditId: number,
  expectedActionCounts: Readonly<Record<string, number>>,
): AuditMutationGuardResult {
  const auditDelta = db
    .prepare(
      `SELECT id, action, entity, entity_id, detail
       FROM audit
       WHERE id > ?
       ORDER BY id`,
    )
    .all(baselineAuditId) as unknown as FixtureAuditRow[];
  const actualActionCounts: Record<string, number> = {};
  for (const row of auditDelta) {
    actualActionCounts[row.action] = (actualActionCounts[row.action] ?? 0) + 1;
  }
  const actions = new Set([
    ...Object.keys(expectedActionCounts),
    ...Object.keys(actualActionCounts),
  ]);
  const passed = [...actions].every(
    (action) => (actualActionCounts[action] ?? 0) === (expectedActionCounts[action] ?? 0),
  );
  return {
    passed,
    reason: passed
      ? 'The audited mutation delta exactly matches the task contract.'
      : 'The audited mutation delta contains missing, repeated, or unrelated operations.',
    evidence: {
      baselineAuditId,
      expectedActionCounts,
      actualActionCounts,
      auditDelta,
    },
  };
}

/** Canonical read-only hash over every application table and row. */
export function canonicalDatabaseFingerprint(db: DatabaseSync): string {
  const hash = createHash('sha256');
  const tables = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
  for (const table of tables) {
    hash.update(stableJson({ table: table.name, sql: table.sql }), 'utf8');
    // Node 22.13 can finalize a temporary StatementSync before its iterator is
    // exhausted. Materialize the bounded fixture table while the statement is
    // live so the minimum supported runtime produces the same canonical hash.
    const statement = db.prepare(
      `SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY rowid`,
    );
    const rows = statement.all() as DatabaseRow[];
    for (const row of rows) hash.update(`\n${stableJson(row)}`, 'utf8');
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

const normalizedProfile = (
  profile: FixtureAgentTargetOptions['fixture'] = {},
): NormalizedFixtureAgentProfile => ({
  seed: profile.seed ?? DEFAULT_FIXTURE_AGENT_PROFILE.seed,
  customers: profile.customers ?? DEFAULT_FIXTURE_AGENT_PROFILE.customers,
  vehicles: profile.vehicles ?? DEFAULT_FIXTURE_AGENT_PROFILE.vehicles,
  apiLatencyMs: profile.apiLatencyMs ?? DEFAULT_FIXTURE_AGENT_PROFILE.apiLatencyMs,
  pageLatencyMs: profile.pageLatencyMs ?? DEFAULT_FIXTURE_AGENT_PROFILE.pageLatencyMs,
});

export const fixtureAgentTargetVersion = (
  profile: FixtureAgentTargetOptions['fixture'] = {},
  headless = true,
): string =>
  `sha256:${sha256(
    stableJson({
      suiteVersion: FIXTURE_AGENT_SUITE_VERSION,
      fixture: normalizedProfile(profile),
      browser: { profile: FIXTURE_AGENT_BROWSER_PROFILE, headless },
      networkPolicy: {
        id: 'fixture-origin-only-v1',
        serviceWorkers: 'block',
      },
      controlApi: false,
      auditGuard: {
        version: FIXTURE_AUDIT_GUARD_VERSION,
        policies: TASKS.map((task) => ({ id: task.id, actions: auditActionPolicy(task.id) })),
      },
      oracles: TASKS.map((task) => ({ id: task.id, oracleVersion: task.oracleVersion })),
    }),
  )}`;

const taskVersion = (task: (typeof TASKS)[number]): string =>
  `sha256:${sha256(
    stableJson({
      id: task.id,
      prompt: task.prompt,
      skills: task.skills,
      oracleVersion: task.oracleVersion,
    }),
  )}`;

const reportedAnswerTasks = new Set([
  'highest-revenue-poland',
  'reserve-cheapest-in-stock',
]);

function submissionContract(taskId: string): AgentSubmissionContract {
  const reportsAnswer = reportedAnswerTasks.has(taskId);
  return {
    description: reportsAnswer
      ? 'Submit the exact customer number or VIN requested by the task in the answer field.'
      : 'Confirm that the requested browser operation is complete.',
    inputSchema: reportsAnswer
      ? {
          type: 'object',
          properties: { answer: { type: 'string', minLength: 1 } },
          required: ['answer'],
          additionalProperties: false,
        }
      : { type: 'object', properties: {}, additionalProperties: false },
    validateInput(input) {
      const keys = Object.keys(input);
      if (reportsAnswer) {
        return keys.length === 1 && typeof input['answer'] === 'string' && input['answer'].length > 0
          ? undefined
          : 'Exactly one non-empty string field named answer is required.';
      }
      return keys.length === 0 ? undefined : 'This task requires an empty result object.';
    },
  };
}

function expectedReportedAnswer(db: DatabaseSync, taskId: string): string | undefined {
  if (taskId === 'highest-revenue-poland') {
    const row = db
      .prepare(
        "SELECT number FROM customers WHERE country = 'Poland' ORDER BY revenue DESC, id ASC LIMIT 1",
      )
      .get() as { number: string } | undefined;
    return row?.number;
  }
  if (taskId === 'reserve-cheapest-in-stock') {
    const row = db
      .prepare(
        `SELECT vin FROM vehicles
         WHERE status = 'In stock'
            OR id IN (
              SELECT CAST(entity_id AS INTEGER) FROM audit
              WHERE action = 'vehicle.status' AND detail LIKE 'In stock → %'
            )
         ORDER BY price_cents ASC, id ASC LIMIT 1`,
      )
      .get() as { vin: string } | undefined;
    return row?.vin;
  }
  return undefined;
}

export function fixtureAgentTasks(ids?: readonly string[]): AgentBenchmarkTask[] {
  const selected = ids === undefined
    ? TASKS
    : ids.map((id) => {
        const task = taskById(id);
        if (task === undefined) throw new Error(`Unknown fixture task: ${id}`);
        return task;
      });
  return selected.map((task) => ({
    id: task.id,
    prompt: task.prompt,
    skills: [...task.skills],
    version: taskVersion(task),
  }));
}

export function createFixtureAgentTargetFactory(
  options: FixtureAgentTargetOptions = {},
): (task: AgentBenchmarkTask, trialIndex: number) => Promise<AgentTrialTarget> {
  const profile = normalizedProfile(options.fixture);
  const headless = options.headless ?? true;
  const targetVersion = fixtureAgentTargetVersion(profile, headless);
  return async (benchmarkTask, trialIndex) => {
    const task = taskById(benchmarkTask.id);
    if (task === undefined) throw new Error(`Unknown fixture task: ${benchmarkTask.id}`);
    if (benchmarkTask.version !== taskVersion(task) || benchmarkTask.prompt !== task.prompt) {
      throw new Error(`Fixture task contract drift for ${benchmarkTask.id}.`);
    }
    const app = await startAppServer({ ...profile, enableControlApi: false });
    const baselineAuditId = Number(
      (app.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit').get() as DatabaseRow)['id'],
    );
    const expectedActionCounts = expectedAuditActionCounts(app.db, task.id);
    let rawTools;
    try {
      rawTools = await (options.toolBrokerFactory === undefined
        ? createBrowserIrMcpToolBroker({
            clientName: `browserir-agent-${benchmarkTask.id}-${trialIndex}`,
            headless,
            allowedOrigins: [app.origin],
            serviceWorkers: 'block',
          })
        : options.toolBrokerFactory({
            task: benchmarkTask,
            trialIndex,
            origin: app.origin,
            headless,
            browserProfile: FIXTURE_AGENT_BROWSER_PROFILE,
          }));
    } catch (error) {
      await app.close().catch(() => {});
      throw error;
    }
    const profiledTools = pinBrowserProfile(rawTools, FIXTURE_AGENT_BROWSER_PROFILE);
    const tools = restrictBrowserNavigation(profiledTools, {
      allowedOrigin: app.origin,
      allowedPathPrefixes: ['/app/'],
      allowedExactPaths: ['/'],
    });
    const submission = submissionContract(task.id);
    let stopPromise: Promise<void> | undefined;
    const stopAgentAccess = (): Promise<void> => {
      stopPromise ??= (async () => {
        let firstError: unknown;
        await tools.close().catch((error) => {
          firstError = error;
        });
        await app.close().catch((error) => {
          firstError ??= error;
        });
        if (firstError !== undefined) throw firstError;
      })();
      return stopPromise;
    };
    const judge = (input?: DeterministicJudgeInput): DeterministicJudgeResult => {
      const oracle = task.verify(app.db);
      const mutationGuard = evaluateAuditMutationGuard(
        app.db,
        baselineAuditId,
        expectedActionCounts,
      );
      const expectedAnswer = expectedReportedAnswer(app.db, task.id);
      const submittedAnswer = input?.submittedResult?.['answer'];
      const isFinal = input?.phase === 'final';
      const submissionPassed =
        !isFinal ||
        (input.submitted &&
          input.submissionAttempts === 1 &&
          (expectedAnswer === undefined || submittedAnswer === expectedAnswer));
      const criteria = [
        {
          id: 'database-and-audit-oracle',
          required: true,
          passed: oracle.passed,
          description: oracle.reason,
          evidence: oracle.evidence,
        },
        ...(isFinal
          ? [
              {
                id: 'no-collateral-audited-mutations',
                required: true,
                passed: mutationGuard.passed,
                description: mutationGuard.reason,
                evidence: mutationGuard.evidence,
              },
              {
                id: 'structured-result',
                required: true,
                passed: submissionPassed,
                description:
                  expectedAnswer === undefined
                    ? 'The agent submitted completion exactly once.'
                    : 'The agent submitted the exact requested business identifier exactly once.',
                evidence: {
                  attempts: input.submissionAttempts,
                  submitted: input.submitted,
                  ...(expectedAnswer === undefined ? {} : { expectedAnswer, submittedAnswer }),
                },
              },
            ]
          : []),
      ];
      const passed = oracle.passed && (!isFinal || mutationGuard.passed) && submissionPassed;
      return {
        outcome: oracle.outcome === 'not_applicable' ? 'invalid' : passed ? 'passed' : 'failed',
        oracleVersion: task.oracleVersion,
        stateFingerprint: canonicalDatabaseFingerprint(app.db),
        criteria,
        evidence: oracle.evidence,
        reason: !oracle.passed
          ? oracle.reason
          : isFinal && !mutationGuard.passed
            ? mutationGuard.reason
            : submissionPassed
              ? oracle.reason
              : 'The browser state passed, but the structured result was missing, duplicated, or wrong.',
      };
    };
    return {
      targetId: `fixture:${benchmarkTask.id}:${trialIndex}`,
      targetVersion,
      origin: app.origin,
      tools,
      submission,
      async judge(input) {
        return judge(input);
      },
      stopAgentAccess,
      async dispose() {
        await stopAgentAccess();
      },
    } satisfies AgentTrialTarget;
  };
}
