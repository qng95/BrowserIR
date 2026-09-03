import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/client';
import type { AdaptivePlaywrightRawClient } from 'browserir-mcp';
import {
  ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS,
  ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256,
  ADAPTIVE_ACCURACY_HOLDOUT_VERSION,
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
  adaptiveAccuracyHoldoutCases,
  expectedAdaptiveAccuracyHoldoutTarget,
  type AdaptiveAccuracyHoldoutCaseId,
  type AdaptiveAccuracyHoldoutFamily,
  type AdaptiveAccuracyHoldoutWorldId,
} from '@think-dom/fixture-app';

import { createAdaptiveProductAbBroker } from
  './agent-benchmark/adaptive-product-ab-broker.js';
import { analyzeBrowserIrRetries } from
  './agent-benchmark/browserir-retry-analysis.js';
import { executeBrowserIrFreshStateRetryPair } from
  './agent-benchmark/browserir-retry-executor.js';
import {
  BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION,
  witnessBrowserIrGeometricRecoverability,
} from './agent-benchmark/browserir-recoverability-witness.js';
import { createOfficialBrowserIrHoldoutZeroModelDependencies } from
  './agent-benchmark/browserir-holdout-zero-model-live.js';
import {
  parsePlaywrightInlineSnapshot,
  parsePlaywrightSnapshotNodes,
} from './agent-benchmark/playwright-snapshot-document.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL_ID = 'qwen/qwen3.8-27b';
const PROVIDER_ROUTE = 'alibaba';
const PROMPT_USD_PER_MILLION = 0.425;
const COMPLETION_USD_PER_MILLION = 2.55;
const ONE_SHOT_SYSTEM_PROMPT = [
  'The current browser_snapshot has already been supplied.',
  'Complete the user task with exactly one browser_click tool call and then stop.',
  'Use one current target reference copied from that snapshot.',
  'Include a short human-readable element description.',
  'Do not return prose or call any other tool.',
].join(' ');
const TOTAL_PAIRS = ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS.length *
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS.length;
const pairStartSource = process.env['BROWSERIR_REAL_AB_PAIR_START'] ?? '0';
const PAIR_START = Number(pairStartSource);
const pairLimitSource = process.env['BROWSERIR_REAL_AB_PAIR_LIMIT'] ??
  String(TOTAL_PAIRS - PAIR_START);
const PAIR_LIMIT = Number(pairLimitSource);
const maxRetriesSource = process.env['BROWSERIR_REAL_AB_MAX_RETRIES'] ?? '2';
const MAX_RETRIES = Number(maxRetriesSource);
const costStopSource = process.env['BROWSERIR_REAL_AB_COST_STOP_USD'] ?? '0.10';
const COST_STOP_USD = Number(costStopSource);
const summaryPath = process.env['BROWSERIR_REAL_AB_SUMMARY_PATH'];
const journalPath = process.env['BROWSERIR_REAL_AB_JOURNAL_PATH'];
if (!Number.isSafeInteger(PAIR_START) || PAIR_START < 0 || PAIR_START >= TOTAL_PAIRS ||
    String(PAIR_START) !== pairStartSource) {
  throw new Error(
    `BROWSERIR_REAL_AB_PAIR_START must be an integer in [0, ${TOTAL_PAIRS - 1}].`,
  );
}
if (!Number.isSafeInteger(PAIR_LIMIT) || PAIR_LIMIT < 1 ||
    PAIR_LIMIT > TOTAL_PAIRS - PAIR_START ||
    String(PAIR_LIMIT) !== pairLimitSource) {
  throw new Error('BROWSERIR_REAL_AB_PAIR_LIMIT exceeds the remaining pair range.');
}
if (
  !Number.isSafeInteger(MAX_RETRIES) || MAX_RETRIES < 0 || MAX_RETRIES > 5 ||
  String(MAX_RETRIES) !== maxRetriesSource
) throw new Error('BROWSERIR_REAL_AB_MAX_RETRIES must be an integer in [0, 5].');
if (
  !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(costStopSource) ||
  !Number.isFinite(COST_STOP_USD) || COST_STOP_USD <= 0 || COST_STOP_USD > 10
) throw new Error('BROWSERIR_REAL_AB_COST_STOP_USD must be in (0, 10].');
if (summaryPath !== undefined && !isAbsolute(summaryPath)) {
  throw new Error('BROWSERIR_REAL_AB_SUMMARY_PATH must be absolute when provided.');
}
if (journalPath !== undefined && !isAbsolute(journalPath)) {
  throw new Error('BROWSERIR_REAL_AB_JOURNAL_PATH must be absolute when provided.');
}
delete process.env['BROWSERIR_REAL_AB_PAIR_LIMIT'];
delete process.env['BROWSERIR_REAL_AB_PAIR_START'];
delete process.env['BROWSERIR_REAL_AB_MAX_RETRIES'];
delete process.env['BROWSERIR_REAL_AB_COST_STOP_USD'];
delete process.env['BROWSERIR_REAL_AB_SUMMARY_PATH'];
delete process.env['BROWSERIR_REAL_AB_JOURNAL_PATH'];
const MAX_ATTEMPTS_PER_TASK = MAX_RETRIES + 1;
const MAX_CALLS = PAIR_LIMIT * 2 * MAX_ATTEMPTS_PER_TASK;
const CURRENT_REF = /^(?:f[1-9]\d*)?e[1-9]\d*$/u;

type Mode = 'off' | 'auto';

interface ArmResult {
  readonly taskId: string;
  readonly caseId: AdaptiveAccuracyHoldoutCaseId;
  readonly worldId: AdaptiveAccuracyHoldoutWorldId;
  readonly mode: Mode;
  readonly attemptNumber: number;
  readonly retryIndex: number;
  readonly seed: number;
  readonly productOutcome: string;
  readonly modelOutcome:
    | 'decision'
    | 'provider-failure'
    | 'malformed-response'
    | 'dispatch-failure';
  readonly selectedRef: string | null;
  readonly exactOracleSuccess: boolean;
  readonly mutationCount: number;
  readonly totalAuditMutationCount: number;
  /** OpenRouter request/response time; diagnostic only, not task latency. */
  readonly modelCallLatencyMs: number;
  /** Full fresh-arm wall clock from setup through terminal oracle verification. */
  readonly taskAttemptLatencyMs: number;
  /** Cleanup/reset after the terminal oracle; counted only when another retry follows. */
  readonly postTerminalCleanupLatencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  readonly responseSha256: string | null;
  readonly failure: string | null;
  readonly relationAudit: OpaqueRelationAudit | null;
}

interface OpaqueRelationAudit {
  readonly witnessVersion: typeof BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION;
  readonly witnessOutcome: 'resolved' | 'unresolved';
  readonly witnessReasonCode: string;
  readonly safeFallback: boolean;
  readonly projectionMiss: boolean;
  readonly relationStatus:
    | 'demonstrated-recoverable'
    | 'recoverability-not-demonstrated';
}

const key = process.env['OPENROUTER_API_KEY'];
if (key === undefined || key.length < 16) {
  throw new Error('OPENROUTER_API_KEY is unavailable to the real A/B runner.');
}
delete process.env['OPENROUTER_API_KEY'];

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const resultText = (result: CallToolResult, label: string): string => {
  if (result.isError === true) throw new Error(`${label} returned an MCP error.`);
  const text = result.content.flatMap((block) =>
    block.type === 'text' ? [block.text] : []).join('\n');
  if (text.length === 0) throw new Error(`${label} returned no text.`);
  return text;
};

const assertSuccessful = (result: CallToolResult, label: string): void => {
  if (result.isError === true) throw new Error(`${label} returned an MCP error.`);
};

const escapedRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const refFor = (result: CallToolResult, role: string, name: string): string => {
  const match = new RegExp(
    `- ${escapedRegExp(role)} "${escapedRegExp(name)}"[^\\n]*\\[ref=([^\\]]+)\\]`,
    'u',
  ).exec(resultText(result, 'Login snapshot'));
  if (match?.[1] === undefined || !CURRENT_REF.test(match[1])) {
    throw new Error(`Login snapshot lacks ${role} ${name}.`);
  }
  return match[1];
};

const authenticate = async (
  broker: ReturnType<typeof createAdaptiveProductAbBroker>,
  origin: string,
): Promise<void> => {
  assertSuccessful(await broker.callTool({
    name: 'browser_navigate', arguments: { url: `${origin}/app/login` },
  }), 'Login navigation');
  const snapshot = await broker.callTool({ name: 'browser_snapshot', arguments: {} });
  assertSuccessful(await broker.callTool({
    name: 'browser_type',
    arguments: {
      target: refFor(snapshot, 'textbox', 'Username'),
      element: 'Username',
      text: 'test',
    },
  }), 'Username entry');
  assertSuccessful(await broker.callTool({
    name: 'browser_type',
    arguments: {
      target: refFor(snapshot, 'textbox', 'Password'),
      element: 'Password',
      text: 'test',
    },
  }), 'Password entry');
  assertSuccessful(await broker.callTool({
    name: 'browser_click',
    arguments: {
      target: refFor(snapshot, 'button', 'Sign in'),
      element: 'Sign in',
    },
  }), 'Login submit');
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const nonNegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const exactTwoSidedBinomialP = (positive: number, negative: number): number => {
  const nonTies = positive + negative;
  if (nonTies === 0) return 1;
  const tailEnd = Math.min(positive, negative);
  let probability = 2 ** -nonTies;
  let tail = probability;
  for (let successes = 0; successes < tailEnd; successes += 1) {
    probability *= (nonTies - successes) / (successes + 1);
    tail += probability;
  }
  return Math.min(1, 2 * tail);
};

const currentRefs = (snapshotText: string): ReadonlySet<string> => {
  const document = parsePlaywrightInlineSnapshot(snapshotText);
  if (document === undefined) throw new Error('Study snapshot has no exact inline document.');
  const refs = new Set(parsePlaywrightSnapshotNodes(document.snapshotTree)
    .flatMap(({ ref }) => ref === undefined ? [] : [ref]));
  if (refs.size === 0) throw new Error('Study snapshot contains no current refs.');
  return refs;
};

const relationMatches = (
  family: AdaptiveAccuracyHoldoutFamily,
  attributes: Readonly<Record<string, string>>,
  relation: (typeof adaptiveAccuracyHoldoutCases)[AdaptiveAccuracyHoldoutCaseId]['requestedRelation'],
): boolean => family === 'schedule-coordinate'
  ? relation.kind === 'schedule-coordinate' &&
    attributes['resource'] === relation.resource && attributes['slot'] === relation.slot
  : relation.kind === 'cross-tree-label' && attributes['label'] === relation.label;

const auditOpaqueRelation = (input: {
  caseId: AdaptiveAccuracyHoldoutCaseId;
  worldId: AdaptiveAccuracyHoldoutWorldId;
  family: AdaptiveAccuracyHoldoutFamily;
  productOutcome: string;
  hidden: CallToolResult;
}): OpaqueRelationAudit => {
  const document = parsePlaywrightInlineSnapshot(resultText(input.hidden, 'Hidden snapshot'));
  if (document === undefined) throw new Error('Hidden snapshot has no exact inline document.');
  const study = adaptiveAccuracyHoldoutCases[input.caseId];
  const witness = witnessBrowserIrGeometricRecoverability({
    family: input.family,
    snapshotTree: document.snapshotTree,
    actionName: study.actionName,
    expectedFactCount: study.targetIds.length,
  });
  if (witness.kind === 'resolved') {
    const nodes = parsePlaywrightSnapshotNodes(document.snapshotTree);
    const candidates = nodes.filter((node) =>
      node.role === 'button' && node.ref !== undefined && node.name === study.actionName);
    const expectedTarget = expectedAdaptiveAccuracyHoldoutTarget(input.caseId, input.worldId);
    const expectedRef = candidates[study.targetIds.indexOf(expectedTarget)]?.ref;
    const requested = witness.facts.filter(({ attributes }) =>
      relationMatches(input.family, attributes, study.requestedRelation));
    if (
      candidates.length !== study.targetIds.length || expectedRef === undefined ||
      requested.length !== 1 || requested[0]!.ref !== expectedRef
    ) throw new Error('Geometric recoverability witness disagrees with the fixture oracle.');
  }
  const safeFallback = input.productOutcome === 'projection-unresolved';
  const projectionMiss = safeFallback && witness.kind === 'resolved';
  return Object.freeze({
    witnessVersion: BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION,
    witnessOutcome: witness.kind,
    witnessReasonCode: witness.reasonCode,
    safeFallback,
    projectionMiss,
    relationStatus: input.productOutcome === 'projected' || witness.kind === 'resolved'
      ? 'demonstrated-recoverable'
      : 'recoverability-not-demonstrated',
  });
};

interface ModelDecision {
  readonly outcome: 'decision' | 'provider-failure' | 'malformed-response';
  readonly target: string | null;
  readonly element: string | null;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  readonly responseSha256: string | null;
  readonly failure: string | null;
}

let physicalCalls = 0;
let observedCostUsd = 0;

const modelDecision = async (input: {
  taskPrompt: string;
  snapshotText: string;
  clickDescription: string;
  clickInputSchema: unknown;
  seed: number;
}): Promise<ModelDecision> => {
  if (physicalCalls >= MAX_CALLS) throw new Error('Real A/B physical-call ceiling reached.');
  if (observedCostUsd >= COST_STOP_USD) throw new Error('Real A/B cost stop reached.');
  const body = JSON.stringify({
    model: MODEL_ID,
    messages: [
      {
        role: 'system',
        content: `${ONE_SHOT_SYSTEM_PROMPT} ` +
          'In browser_click arguments, target is the exact ref token such as e7; ' +
          'element is the human-readable description.',
      },
      {
        role: 'user',
        content: `${input.taskPrompt}\n\nCurrent browser_snapshot:\n${input.snapshotText}`,
      },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'browser_click',
        description: input.clickDescription,
        parameters: input.clickInputSchema,
      },
    }],
    tool_choice: 'auto',
    max_tokens: 512,
    temperature: 0,
    seed: input.seed,
    reasoning: { effort: 'low' },
    stream: false,
    provider: {
      only: [PROVIDER_ROUTE],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
    },
  });
  physicalCalls += 1;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-title': 'BrowserIR real matched A/B smoke',
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return {
      outcome: 'provider-failure', target: null, element: null,
      latencyMs: Math.round(performance.now() - started),
      promptTokens: null, completionTokens: null, costUsd: null,
      responseSha256: null,
      failure: error instanceof Error ? error.name : 'transport-error',
    };
  }
  const responseText = await response.text();
  const latencyMs = Math.round(performance.now() - started);
  const responseSha256 = sha256(responseText);
  let parsed: unknown;
  try { parsed = JSON.parse(responseText) as unknown; } catch {
    return {
      outcome: 'malformed-response', target: null, element: null, latencyMs,
      promptTokens: null, completionTokens: null, costUsd: null,
      responseSha256, failure: `non-json-http-${response.status}`,
    };
  }
  const root = record(parsed);
  const usage = record(root?.['usage']);
  const promptTokens = nonNegative(usage?.['prompt_tokens']);
  const completionTokens = nonNegative(usage?.['completion_tokens']);
  const providerCost = nonNegative(usage?.['cost']);
  const derivedCost = providerCost ?? (
    promptTokens === null || completionTokens === null
      ? null
      : promptTokens * PROMPT_USD_PER_MILLION / 1_000_000 +
        completionTokens * COMPLETION_USD_PER_MILLION / 1_000_000
  );
  if (derivedCost !== null) observedCostUsd += derivedCost;
  if (!response.ok || root?.['error'] !== undefined) {
    return {
      outcome: 'provider-failure', target: null, element: null, latencyMs,
      promptTokens, completionTokens, costUsd: derivedCost,
      responseSha256, failure: `openrouter-http-${response.status}`,
    };
  }
  try {
    const choices = root?.['choices'];
    if (!Array.isArray(choices) || choices.length !== 1) throw new Error('choices');
    const message = record(record(choices[0])?.['message']);
    const calls = message?.['tool_calls'];
    if (!Array.isArray(calls) || calls.length !== 1) throw new Error('tool-calls');
    const fn = record(record(calls[0])?.['function']);
    if (fn?.['name'] !== 'browser_click' || typeof fn['arguments'] !== 'string') {
      throw new Error('function');
    }
    const args = record(JSON.parse(fn['arguments']) as unknown);
    const target = args?.['target'];
    const element = args?.['element'];
    if (
      typeof target !== 'string' || !CURRENT_REF.test(target) ||
      (element !== undefined && typeof element !== 'string')
    ) throw new Error('arguments');
    return {
      outcome: 'decision', target,
      element: typeof element === 'string' && element.length > 0 ? element : null,
      latencyMs, promptTokens, completionTokens, costUsd: derivedCost,
      responseSha256, failure: null,
    };
  } catch (error) {
    return {
      outcome: 'malformed-response', target: null, element: null, latencyMs,
      promptTokens, completionTokens, costUsd: derivedCost,
      responseSha256,
      failure: error instanceof Error ? `invalid-${error.message}` : 'invalid-response',
    };
  }
};

const dependencies = createOfficialBrowserIrHoldoutZeroModelDependencies({ headless: true });

const runArm = async (input: {
  taskId: string;
  caseId: AdaptiveAccuracyHoldoutCaseId;
  worldId: AdaptiveAccuracyHoldoutWorldId;
  family: AdaptiveAccuracyHoldoutFamily;
  mode: Mode;
  attemptNumber: number;
  seed: number;
}): Promise<Omit<ArmResult, 'postTerminalCleanupLatencyMs'>> => {
  const taskAttemptStarted = performance.now();
  const session = await dependencies.openArm({
    caseId: input.caseId,
    worldId: input.worldId,
    family: input.family,
  });
  const events: Array<{ outcome: string }> = [];
  const hiddenSnapshots: CallToolResult[] = [];
  const instrumentedRawClient: AdaptivePlaywrightRawClient = {
    async callTool(...args) {
      const result = await session.rawClient.callTool(...args);
      const request = args[0];
      if (
        request.name === 'browser_snapshot' &&
        record(request.arguments)?.['boxes'] === true
      ) hiddenSnapshots.push(result);
      return result;
    },
    listTools: (...args) => session.rawClient.listTools(...args),
  };
  const broker = createAdaptiveProductAbBroker(instrumentedRawClient, {
    mode: input.mode,
    family: input.family,
    telemetry: { onEvent: (event) => events.push(event) },
  });
  try {
    const catalog = await broker.listTools();
    const click = catalog.tools.find(({ name }) => name === 'browser_click');
    if (click === undefined) throw new Error('Official MCP catalog lacks browser_click.');
    await authenticate(broker, session.origin);
    const study = adaptiveAccuracyHoldoutCases[input.caseId];
    assertSuccessful(await broker.callTool({
      name: 'browser_navigate', arguments: { url: `${session.origin}${study.path}` },
    }), 'Study navigation');
    const baseline = await session.verifyZeroOracle();
    if (
      baseline.exactSuccess || baseline.totalAuditMutationCount !== 0 ||
      baseline.totalHoldoutMutationCount !== 0
    ) throw new Error('Fresh-state DB oracle is not zero before treatment.');
    const eventStart = events.length;
    const snapshot = await broker.callTool({ name: 'browser_snapshot', arguments: {} });
    const snapshotText = resultText(snapshot, 'Study snapshot');
    const refs = currentRefs(snapshotText);
    if (events.length !== eventStart + 1) throw new Error('Snapshot telemetry drifted.');
    const productOutcome = events[eventStart]!.outcome;
    const opaqueAuto = input.mode === 'auto' && input.worldId.startsWith('opaque-');
    if (hiddenSnapshots.length !== (opaqueAuto ? 1 : 0)) {
      throw new Error('Real A/B hidden snapshot acquisition count drifted.');
    }
    const relationAudit = opaqueAuto
      ? auditOpaqueRelation({
          caseId: input.caseId,
          worldId: input.worldId,
          family: input.family,
          productOutcome,
          hidden: hiddenSnapshots[0]!,
        })
      : null;
    const decision = await modelDecision({
      taskPrompt: study.prompt,
      snapshotText,
      clickDescription: click.description ?? 'Click an element on the page.',
      clickInputSchema: click.inputSchema,
      seed: input.seed,
    });
    let selectedRef: string | null = null;
    let modelOutcome: ArmResult['modelOutcome'] = decision.outcome;
    let failure = decision.failure;
    if (decision.outcome === 'decision') {
      if (!refs.has(decision.target!)) {
        modelOutcome = 'malformed-response';
        failure = 'target-not-in-current-snapshot';
      } else {
        selectedRef = decision.target;
        try {
          const clicked = await broker.callTool({
            name: 'browser_click',
            arguments: {
              target: decision.target,
              element: decision.element ?? study.actionName,
            },
          });
          if (clicked.isError === true) {
            modelOutcome = 'dispatch-failure';
            failure = 'browser-click-mcp-error';
          }
        } catch (error) {
          modelOutcome = 'dispatch-failure';
          failure = error instanceof Error
            ? `browser-click-${error.name}`
            : 'browser-click-transport-error';
        }
      }
    }
    const oracle = await session.verifyZeroOracle();
    return Object.freeze({
      taskId: input.taskId,
      caseId: input.caseId,
      worldId: input.worldId,
      mode: input.mode,
      attemptNumber: input.attemptNumber,
      retryIndex: input.attemptNumber - 1,
      seed: input.seed,
      productOutcome,
      modelOutcome,
      selectedRef,
      exactOracleSuccess: oracle.exactSuccess,
      mutationCount: oracle.mutationCount,
      totalAuditMutationCount: oracle.totalAuditMutationCount,
      modelCallLatencyMs: decision.latencyMs,
      taskAttemptLatencyMs: Math.round(performance.now() - taskAttemptStarted),
      promptTokens: decision.promptTokens,
      completionTokens: decision.completionTokens,
      costUsd: decision.costUsd,
      responseSha256: decision.responseSha256,
      failure,
      relationAudit,
    });
  } finally {
    const cleanupErrors: unknown[] = [];
    await broker.dispose().catch((error) => cleanupErrors.push(error));
    await session.close().catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Real A/B arm cleanup failed.');
    }
  }
};

const results: ArmResult[] = [];
if (journalPath !== undefined) {
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, '', { encoding: 'utf8', flag: 'wx' });
}
const pairs = ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS.flatMap((caseId) =>
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS.map((worldId) => ({ caseId, worldId })))
  .map((pair, pairIndex) => ({ ...pair, pairIndex }))
  .slice(PAIR_START, PAIR_START + PAIR_LIMIT);

for (const pair of pairs) {
  const study = adaptiveAccuracyHoldoutCases[pair.caseId];
  const taskId = JSON.stringify([pair.caseId, pair.worldId]);
  await executeBrowserIrFreshStateRetryPair({
    pairIndex: pair.pairIndex,
    maxRetries: MAX_RETRIES,
    baseSeed: 20_260_825,
    async runAttempt({ mode, attemptNumber, seed }) {
      const activeAttemptStarted = performance.now();
      const untimedCleanupResult = await runArm({
        taskId,
        caseId: pair.caseId,
        worldId: pair.worldId,
        family: study.familyId,
        mode,
        attemptNumber,
        seed,
      });
      const result = Object.freeze({
        ...untimedCleanupResult,
        postTerminalCleanupLatencyMs: Math.max(
          0,
          Math.round(performance.now() - activeAttemptStarted) -
            untimedCleanupResult.taskAttemptLatencyMs,
        ),
      });
      results.push(result);
      if (journalPath !== undefined) {
        await appendFile(journalPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8' });
      }
      process.stdout.write(
        `REAL_AB_PROGRESS calls=${results.length}/${MAX_CALLS}-max ` +
        `${pair.caseId} ${pair.worldId} ${mode} attempt=${attemptNumber} ` +
        `oracle=${result.exactOracleSuccess ? 'success' : 'failure'} ` +
        `route=${result.productOutcome} task_ms=${result.taskAttemptLatencyMs} ` +
        `cost=${result.costUsd?.toFixed(6) ?? 'unknown'}\n`,
      );
      return result;
    },
  });
}

const paired = pairs.map((pair) => {
  const arms = results.filter((result) =>
    result.caseId === pair.caseId && result.worldId === pair.worldId);
  const offAttempts = arms.filter(({ mode }) => mode === 'off');
  const autoAttempts = arms.filter(({ mode }) => mode === 'auto');
  if (
    new Set(offAttempts.map(({ productOutcome }) => productOutcome)).size !== 1 ||
    new Set(autoAttempts.map(({ productOutcome }) => productOutcome)).size !== 1
  ) throw new Error('Product route changed across fresh retries for one task.');
  const offSuccess = offAttempts.some(({ exactOracleSuccess }) => exactOracleSuccess);
  const autoSuccess = autoAttempts.some(({ exactOracleSuccess }) => exactOracleSuccess);
  return Object.freeze({
    taskId: JSON.stringify([pair.caseId, pair.worldId]),
    caseId: pair.caseId,
    worldId: pair.worldId,
    offSuccess,
    autoSuccess,
    difference: Number(autoSuccess) - Number(offSuccess),
    offAttempts: offAttempts.length,
    autoAttempts: autoAttempts.length,
    offFirstSuccessAttempt: offAttempts.find(({ exactOracleSuccess }) =>
      exactOracleSuccess)?.attemptNumber ?? null,
    autoFirstSuccessAttempt: autoAttempts.find(({ exactOracleSuccess }) =>
      exactOracleSuccess)?.attemptNumber ?? null,
    autoRoute: autoAttempts[0]!.productOutcome,
    relationAudit: autoAttempts[0]!.relationAudit,
  });
});
const retryAnalysis = analyzeBrowserIrRetries({
  tasks: paired.map(({ taskId }) => ({ taskId })),
  attempts: results.map((result) => ({
    taskId: result.taskId,
    mode: result.mode,
    attemptNumber: result.attemptNumber,
    exactOracleSuccess: result.exactOracleSuccess,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    costUsd: result.costUsd,
    taskAttemptLatencyMs: result.taskAttemptLatencyMs,
    postTerminalCleanupLatencyMs: result.postTerminalCleanupLatencyMs,
  })),
  maxRetries: MAX_RETRIES,
});
const caseClusters = [...new Set(paired.map(({ caseId }) => caseId))].map((caseId) => {
  const members = paired.filter((pair) => pair.caseId === caseId);
  const offSuccesses = members.filter(({ offSuccess }) => offSuccess).length;
  const autoSuccesses = members.filter(({ autoSuccess }) => autoSuccess).length;
  return Object.freeze({
    caseId,
    pairs: members.length,
    offSuccesses,
    autoSuccesses,
    difference: autoSuccesses - offSuccesses,
  });
});
const autoOnlyCount = paired.filter(({ autoSuccess, offSuccess }) =>
  autoSuccess && !offSuccess).length;
const offOnlyCount = paired.filter(({ autoSuccess, offSuccess }) =>
  !autoSuccess && offSuccess).length;
const positiveCaseClusters = caseClusters.filter(({ difference }) => difference > 0).length;
const negativeCaseClusters = caseClusters.filter(({ difference }) => difference < 0).length;
const tiedCaseClusters = caseClusters.filter(({ difference }) => difference === 0).length;
const opaqueRelationAudits = paired.flatMap(({ relationAudit }) =>
  relationAudit === null ? [] : [relationAudit]);
const summary = Object.freeze({
  schemaVersion: 'browserir-openrouter-real-ab-smoke/3',
  status: 'real-browser-real-openrouter-descriptive-smoke-not-confirmatory',
  fixtureCatalogVersion: ADAPTIVE_ACCURACY_HOLDOUT_VERSION,
  fixtureCatalogSha256: ADAPTIVE_ACCURACY_HOLDOUT_CATALOG_SHA256,
  model: MODEL_ID,
  providerRoute: PROVIDER_ROUTE,
  pairStart: PAIR_START,
  pairLimit: PAIR_LIMIT,
  totalCatalogPairs: TOTAL_PAIRS,
  pairs: paired.length,
  modelCalls: physicalCalls,
  maxRetries: MAX_RETRIES,
  maxAttemptsPerTask: MAX_ATTEMPTS_PER_TASK,
  maximumPhysicalModelCalls: MAX_CALLS,
  costStopUsd: COST_STOP_USD,
  offSuccesses: paired.filter(({ offSuccess }) => offSuccess).length,
  autoSuccesses: paired.filter(({ autoSuccess }) => autoSuccess).length,
  autoMinusOff: paired.reduce((sum, { difference }) => sum + difference, 0) / paired.length,
  autoOnly: autoOnlyCount,
  offOnly: offOnlyCount,
  both: paired.filter(({ autoSuccess, offSuccess }) => autoSuccess && offSuccess).length,
  neither: paired.filter(({ autoSuccess, offSuccess }) => !autoSuccess && !offSuccess).length,
  pairedSensitivity: {
    method: 'exact-two-sided-mcnemar-binomial',
    discordantPairs: autoOnlyCount + offOnlyCount,
    exactTwoSidedPValue: exactTwoSidedBinomialP(autoOnlyCount, offOnlyCount),
  },
  caseClusterSensitivity: {
    method: 'exact-two-sided-sign-test-excluding-ties',
    positive: positiveCaseClusters,
    negative: negativeCaseClusters,
    ties: tiedCaseClusters,
    exactTwoSidedPValue: exactTwoSidedBinomialP(
      positiveCaseClusters,
      negativeCaseClusters,
    ),
    clusters: caseClusters,
  },
  opaque: {
    pairs: paired.filter(({ worldId }) => worldId.startsWith('opaque-')).length,
    offSuccesses: paired.filter(({ worldId, offSuccess }) =>
      worldId.startsWith('opaque-') && offSuccess).length,
    autoSuccesses: paired.filter(({ worldId, autoSuccess }) =>
      worldId.startsWith('opaque-') && autoSuccess).length,
  },
  semantic: {
    pairs: paired.filter(({ worldId }) => worldId.startsWith('semantic-')).length,
    offSuccesses: paired.filter(({ worldId, offSuccess }) =>
      worldId.startsWith('semantic-') && offSuccess).length,
    autoSuccesses: paired.filter(({ worldId, autoSuccess }) =>
      worldId.startsWith('semantic-') && autoSuccess).length,
  },
  routeCounts: Object.fromEntries([...new Set(results.map(({ productOutcome }) => productOutcome))]
    .map((outcome) => [outcome, results.filter((result) =>
      result.productOutcome === outcome).length])),
  modelOutcomeCounts: Object.fromEntries([
    ...new Set(results.map(({ modelOutcome }) => modelOutcome)),
  ].map((outcome) => [outcome, results.filter((result) =>
      result.modelOutcome === outcome).length])),
  taskRouteCounts: Object.fromEntries([
    ...new Set(paired.map(({ autoRoute }) => autoRoute)),
  ].map((outcome) => [outcome, paired.filter(({ autoRoute }) => autoRoute === outcome).length])),
  projectionAudit: Object.freeze({
    witnessVersion: BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION,
    opaqueAutoTasks: opaqueRelationAudits.length,
    safeFallbacks: opaqueRelationAudits.filter(({ safeFallback }) => safeFallback).length,
    demonstratedRecoverableRelations: opaqueRelationAudits.filter(({ relationStatus }) =>
      relationStatus === 'demonstrated-recoverable').length,
    projectionMisses: opaqueRelationAudits.filter(({ projectionMiss }) => projectionMiss).length,
    unresolvedWithoutRecoverabilityProof: opaqueRelationAudits.filter(({ safeFallback,
      relationStatus }) => safeFallback &&
      relationStatus === 'recoverability-not-demonstrated').length,
  }),
  retryAnalysis,
  totalObservedCostUsd: observedCostUsd,
  meanModelCallLatencyMs: results.reduce(
    (sum, { modelCallLatencyMs }) => sum + modelCallLatencyMs,
    0,
  ) / results.length,
  meanTaskAttemptLatencyMs: results.reduce(
    (sum, { taskAttemptLatencyMs }) => sum + taskAttemptLatencyMs,
    0,
  ) / results.length,
  results,
});

if (summaryPath !== undefined) {
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  process.stdout.write(`BROWSERIR_OPENROUTER_REAL_AB_RECEIPT=${summaryPath}\n`);
}
process.stdout.write(`BROWSERIR_OPENROUTER_REAL_AB_SUMMARY=${JSON.stringify(summary)}\n`);
