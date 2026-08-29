import { createHash } from 'node:crypto';

import type {
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/client';
import type {
  AdaptivePlaywrightMode,
  AdaptivePlaywrightRawClient,
  AdaptivePlaywrightTelemetryEvent,
} from 'browserir';
import {
  ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS,
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS,
  adaptiveAccuracyHoldoutCases,
  expectedAdaptiveAccuracyHoldoutTarget,
  type AdaptiveAccuracyHoldoutCaseId,
  type AdaptiveAccuracyHoldoutFamily,
  type AdaptiveAccuracyHoldoutWorldId,
} from '@think-dom/fixture-app';

import { stableJson } from '../environment.js';
import {
  createCrossTreeLabelSnapshotPolicy,
  createScheduleCoordinateSnapshotPolicy,
} from './adaptive-qualification-policies.js';
import {
  createAdaptiveProductAbBroker,
  type AdaptiveProductAbBinding,
} from './adaptive-product-ab-broker.js';
import {
  BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION,
  witnessBrowserIrGeometricRecoverability,
} from './browserir-recoverability-witness.js';
import type { AdaptiveStructuralFact } from './adaptive-snapshot-policy.js';
import {
  assertSuccessful,
  authenticate,
  parseAdaptiveFacts,
  resultText,
} from './playwright-mcp-live-preflight-helpers.js';
import {
  parsePlaywrightInlineSnapshot,
  parsePlaywrightSnapshotNodes,
} from './playwright-snapshot-document.js';

export const BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_VERSION =
  'browserir-holdout-zero-model-preflight/2' as const;

export const BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_PAIR_COUNT =
  ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS.length *
  ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS.length;
export const BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_ARM_COUNT =
  BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_PAIR_COUNT * 2;

export interface BrowserIrHoldoutZeroModelPreflightCell {
  readonly ordinal: number;
  readonly cellId: string;
  readonly caseId: AdaptiveAccuracyHoldoutCaseId;
  readonly worldId: AdaptiveAccuracyHoldoutWorldId;
  readonly family: AdaptiveAccuracyHoldoutFamily;
  readonly mode: AdaptivePlaywrightMode;
}

export function buildBrowserIrHoldoutZeroModelPreflightSchedule():
readonly BrowserIrHoldoutZeroModelPreflightCell[] {
  const schedule = ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS.flatMap((caseId) => {
    const family = adaptiveAccuracyHoldoutCases[caseId].familyId;
    return ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS.flatMap((worldId) =>
      (['off', 'auto'] as const).map((mode) => ({ caseId, worldId, family, mode })));
  }).map((cell, ordinal) => Object.freeze({
    ordinal,
    cellId: `holdout-preflight-${String(ordinal + 1).padStart(2, '0')}`,
    ...cell,
  }));
  if (schedule.length !== BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_ARM_COUNT) {
    throw new Error('Holdout preflight schedule drifted from its catalog-derived contract.');
  }
  return Object.freeze(schedule);
}

export interface BrowserIrHoldoutZeroOracleSnapshot {
  /** Exact browser-hidden fixture oracle; false before any successful target selection. */
  readonly exactSuccess: boolean;
  readonly mutationCount: number;
  readonly collateralMutationCount: number;
  readonly totalHoldoutMutationCount: number;
  readonly otherAuditMutationCount: number;
  readonly totalAuditMutationCount: number;
}

export interface BrowserIrHoldoutFreshRuntimeIdentity {
  /** PIDs are observed from the two direct child-process handles. */
  readonly fixtureProcessPid: number;
  readonly mcpProcessPid: number;
  /** The remaining values attest construction; they are not browser runtime GUIDs. */
  readonly databaseInstanceAttestationId: string;
  readonly browserContextConstructionAttestationId: string;
  readonly initialPageConstructionAttestationId: string;
}

export interface BrowserIrHoldoutZeroModelArmSession {
  /** Exact loopback origin owned by this fresh fixture process. */
  readonly origin: string;
  /** Caller-owned official MCP Client path. The product wrapper never closes it. */
  readonly rawClient: AdaptivePlaywrightRawClient;
  readonly runtimeIdentity: BrowserIrHoldoutFreshRuntimeIdentity;
  /** Out-of-browser oracle channel; the fixture HTTP control API stays disabled. */
  verifyZeroOracle(): Promise<BrowserIrHoldoutZeroOracleSnapshot>;
  /** Closes the caller-owned MCP/transport/browser, then fixture process/DB. */
  close(): Promise<void>;
}

export interface BrowserIrHoldoutZeroModelPreflightDependencies {
  /**
   * Deliberately receives no treatment mode, ordinal, or treatment-bearing cell
   * identifier. The live-session factory can bind only the shared case/world.
   */
  openArm(input: Readonly<{
    caseId: AdaptiveAccuracyHoldoutCaseId;
    worldId: AdaptiveAccuracyHoldoutWorldId;
    family: AdaptiveAccuracyHoldoutFamily;
  }>): Promise<BrowserIrHoldoutZeroModelArmSession>;
}

type RawCallArguments = Parameters<AdaptivePlaywrightRawClient['callTool']>;
type RawListArguments = Parameters<AdaptivePlaywrightRawClient['listTools']>;

interface RetainedRawCall {
  readonly ordinal: number;
  readonly phase: 'setup' | 'study';
  readonly request: RawCallArguments[0];
  readonly options: RawCallArguments[1];
  readonly result: CallToolResult;
  /** Immutable bytes captured before control returns to the product wrapper. */
  readonly resultBytesAtRawBoundary: string;
}

interface RetainedRawList {
  readonly request: RawListArguments[0];
  readonly options: RawListArguments[1];
  readonly result: ListToolsResult;
  readonly resultBytesAtRawBoundary: string;
}

interface InstrumentedRawClient {
  /** The exact caller-owned object, instrumented in place without result conversion. */
  readonly client: AdaptivePlaywrightRawClient;
  readonly calls: readonly RetainedRawCall[];
  readonly lists: readonly RetainedRawList[];
  beginStudy(visibleRequest: RawCallArguments[0]): void;
  endStudy(): Readonly<{
    visible: RetainedRawCall;
    hidden?: RetainedRawCall | undefined;
  }>;
  restore(): void;
}

/**
 * Retains exact request/result object identities while forwarding to the
 * caller-owned official raw client. It never clones, normalizes, or closes it.
 */
function instrumentRawClient(raw: AdaptivePlaywrightRawClient): InstrumentedRawClient {
  const calls: RetainedRawCall[] = [];
  const lists: RetainedRawList[] = [];
  let studyRequest: RawCallArguments[0] | undefined;
  let studyStart = -1;
  const originalCall = raw.callTool;
  const originalList = raw.listTools;
  const callDescriptor = Object.getOwnPropertyDescriptor(raw, 'callTool');
  const listDescriptor = Object.getOwnPropertyDescriptor(raw, 'listTools');
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (callDescriptor === undefined) Reflect.deleteProperty(raw, 'callTool');
    else Object.defineProperty(raw, 'callTool', callDescriptor);
    if (listDescriptor === undefined) Reflect.deleteProperty(raw, 'listTools');
    else Object.defineProperty(raw, 'listTools', listDescriptor);
  };
  try {
    Object.defineProperties(raw, {
      callTool: {
        configurable: true,
        enumerable: callDescriptor?.enumerable ?? false,
        writable: true,
        async value(...args: RawCallArguments): Promise<CallToolResult> {
          const phase = studyRequest === undefined ? 'setup' : 'study';
          const result = await Reflect.apply(originalCall, raw, args) as CallToolResult;
          calls.push(Object.freeze({
            ordinal: calls.length,
            phase,
            request: args[0],
            options: args[1],
            result,
            resultBytesAtRawBoundary: resultBytes(result),
          }));
          return result;
        },
      },
      listTools: {
        configurable: true,
        enumerable: listDescriptor?.enumerable ?? false,
        writable: true,
        async value(...args: RawListArguments): Promise<ListToolsResult> {
          const result = await Reflect.apply(originalList, raw, args) as ListToolsResult;
          lists.push(Object.freeze({
            request: args[0],
            options: args[1],
            result,
            resultBytesAtRawBoundary: resultBytes(result),
          }));
          return result;
        },
      },
    });
  } catch (error) {
    restore();
    throw error;
  }
  return {
    client: raw,
    calls,
    lists,
    beginStudy(visibleRequest) {
      if (studyRequest !== undefined) throw new Error('A study snapshot is already active.');
      studyRequest = visibleRequest;
      studyStart = calls.length;
    },
    endStudy() {
      if (studyRequest === undefined || studyStart < 0) {
        throw new Error('No study snapshot is active.');
      }
      const retained = calls.slice(studyStart);
      const expectedRequest = studyRequest;
      studyRequest = undefined;
      studyStart = -1;
      const visible = retained[0];
      if (visible === undefined || visible.request !== expectedRequest) {
        throw new Error('Product did not forward the exact visible snapshot request first.');
      }
      if (retained.length < 1 || retained.length > 2) {
        throw new Error('Study snapshot made an unexpected number of raw MCP calls.');
      }
      return Object.freeze({
        visible,
        ...(retained[1] === undefined ? {} : { hidden: retained[1] }),
      });
    },
    restore,
  };
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function resultBytes(result: CallToolResult | ListToolsResult): string {
  const encoded = JSON.stringify(result);
  if (encoded === undefined) throw new Error('Raw MCP result is not JSON serializable.');
  return encoded;
}

const exactLoopbackOrigin = (origin: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Holdout preflight fixture origin is not an absolute URL.');
  }
  if (
    parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
    parsed.origin !== origin || parsed.pathname !== '/' || parsed.search !== '' ||
    parsed.hash !== ''
  ) throw new Error('Holdout preflight permits one exact IPv4 loopback origin only.');
  return origin;
};

const assertZeroOracle = (
  oracle: BrowserIrHoldoutZeroOracleSnapshot,
  label: string,
): void => {
  if (
    oracle.exactSuccess !== false ||
    oracle.mutationCount !== 0 || oracle.collateralMutationCount !== 0 ||
    oracle.totalHoldoutMutationCount !== 0 || oracle.otherAuditMutationCount !== 0 ||
    oracle.totalAuditMutationCount !== 0
  ) throw new Error(`${label} detected a holdout or collateral DB mutation.`);
};

const exactRequest = (
  request: RawCallArguments[0],
  name: string,
  expectedArguments: Readonly<Record<string, unknown>>,
): boolean => {
  if (request === null || typeof request !== 'object') return false;
  const value = request as { name?: unknown; arguments?: unknown };
  return value.name === name && stableJson(value.arguments) === stableJson(expectedArguments) &&
    Reflect.ownKeys(request).length === 2;
};

const expectedPolicyVersion = (
  family: AdaptiveAccuracyHoldoutFamily,
): AdaptiveProductAbBinding['policyVersion'] => family === 'schedule-coordinate'
  ? 'schedule-coordinate-policy/3'
  : 'cross-tree-label-policy/1';

const assertProductBinding = (
  cell: BrowserIrHoldoutZeroModelPreflightCell,
  binding: AdaptiveProductAbBinding,
): void => {
  if (
    binding.schemaVersion !== 'adaptive-product-ab-broker/1' ||
    binding.productToolsVersion !== 'adaptive-playwright-tools/1' ||
    binding.productPoliciesVersion !== 'adaptive-reference-policies/1' ||
    binding.mode !== cell.mode || binding.family !== cell.family ||
    binding.policyVersion !== expectedPolicyVersion(cell.family)
  ) throw new Error(`${cell.cellId} exact first-party product provenance drifted.`);
};

const bindingWithoutMode = (binding: AdaptiveProductAbBinding) => {
  const { mode: _mode, ...retained } = binding;
  return retained;
};

const relationMatches = (
  family: AdaptiveAccuracyHoldoutFamily,
  attributes: Readonly<Record<string, string>>,
  relation: (typeof adaptiveAccuracyHoldoutCases)[AdaptiveAccuracyHoldoutCaseId]['requestedRelation'],
): boolean => family === 'schedule-coordinate'
  ? relation.kind === 'schedule-coordinate' &&
    attributes['resource'] === relation.resource && attributes['slot'] === relation.slot
  : relation.kind === 'cross-tree-label' && attributes['label'] === relation.label;

const assertCompleteReferenceFacts = (input: {
  cell: BrowserIrHoldoutZeroModelPreflightCell;
  hiddenSnapshotTree: string;
  facts: readonly AdaptiveStructuralFact[];
}): void => {
  const study = adaptiveAccuracyHoldoutCases[input.cell.caseId];
  const factKind = input.cell.family === 'schedule-coordinate'
    ? 'schedule-slot'
    : 'cross-tree-label';
  if (
    input.facts.length !== study.targetIds.length ||
    input.facts.some(({ kind }) => kind !== factKind) ||
    new Set(input.facts.map(({ ref }) => ref)).size !== input.facts.length
  ) throw new Error(`${input.cell.cellId} reference projection is incomplete.`);
  const hiddenNodes = parsePlaywrightSnapshotNodes(input.hiddenSnapshotTree);
  const hiddenCandidates = hiddenNodes.filter((node) =>
    node.role === 'button' && node.ref !== undefined && node.name === study.actionName);
  const candidateRefs = new Set(hiddenCandidates.flatMap(({ ref }) =>
    ref === undefined ? [] : [ref]));
  if (
    hiddenCandidates.length !== study.targetIds.length ||
    input.facts.some(({ ref }) => !candidateRefs.has(ref))
  ) throw new Error(`${input.cell.cellId} reference facts do not cover current candidate refs.`);
  const expectedTarget = expectedAdaptiveAccuracyHoldoutTarget(
    input.cell.caseId,
    input.cell.worldId,
  );
  const expectedIndex = study.targetIds.indexOf(expectedTarget);
  const expectedRef = hiddenCandidates[expectedIndex]?.ref;
  const requestedFacts = input.facts.filter(({ attributes }) =>
    relationMatches(input.cell.family, attributes, study.requestedRelation));
  if (
    expectedRef === undefined || requestedFacts.length !== 1 ||
    requestedFacts[0]!.ref !== expectedRef
  ) throw new Error(`${input.cell.cellId} reference relation disagrees with the fixture oracle.`);
};

const evaluateReferenceRecoverability = async (input: {
  cell: BrowserIrHoldoutZeroModelPreflightCell;
  visible: CallToolResult;
  hidden: CallToolResult;
}): Promise<Readonly<{
  outcome: 'resolved' | 'unresolved';
  policyVersion: 'schedule-coordinate-policy/1' | 'cross-tree-label-policy/1';
  reasonCode: string;
}>> => {
  const visibleDocument = parsePlaywrightInlineSnapshot(
    resultText(input.visible, `${input.cell.cellId} reference visible snapshot`),
  );
  const hiddenDocument = parsePlaywrightInlineSnapshot(
    resultText(input.hidden, `${input.cell.cellId} reference boxed snapshot`),
  );
  if (visibleDocument === undefined || hiddenDocument === undefined) {
    throw new Error(`${input.cell.cellId} reference projection lacks an inline document.`);
  }
  const policy = input.cell.family === 'schedule-coordinate'
    ? createScheduleCoordinateSnapshotPolicy()
    : createCrossTreeLabelSnapshotPolicy();
  const decision = policy.evaluate({ snapshotTree: visibleDocument.snapshotTree });
  if (decision.kind !== 'require' || decision.feature !== 'geometry') {
    throw new Error(`${input.cell.cellId} opaque reference policy did not require geometry.`);
  }
  const projection = await policy.project({
    feature: 'geometry',
    baselineSnapshotTree: visibleDocument.snapshotTree,
    featureSnapshotTree: hiddenDocument.snapshotTree,
  });
  if (projection.kind === 'resolved') {
    if (projection.supplement === undefined) {
      throw new Error(`${input.cell.cellId} resolved reference projection has no facts.`);
    }
    assertCompleteReferenceFacts({
      cell: input.cell,
      hiddenSnapshotTree: hiddenDocument.snapshotTree,
      facts: projection.supplement.facts,
    });
  }
  return Object.freeze({
    outcome: projection.kind,
    policyVersion: policy.version as
      | 'schedule-coordinate-policy/1'
      | 'cross-tree-label-policy/1',
    reasonCode: projection.code,
  });
};

const evaluateGeometricWitness = (input: {
  cell: BrowserIrHoldoutZeroModelPreflightCell;
  hidden: CallToolResult;
}): Readonly<{
  outcome: 'resolved' | 'unresolved';
  reasonCode: string;
}> => {
  const document = parsePlaywrightInlineSnapshot(
    resultText(input.hidden, `${input.cell.cellId} geometric witness snapshot`),
  );
  if (document === undefined) {
    throw new Error(`${input.cell.cellId} geometric witness lacks an inline document.`);
  }
  const study = adaptiveAccuracyHoldoutCases[input.cell.caseId];
  const witness = witnessBrowserIrGeometricRecoverability({
    family: input.cell.family,
    snapshotTree: document.snapshotTree,
    actionName: study.actionName,
    expectedFactCount: study.targetIds.length,
  });
  if (witness.kind === 'resolved') {
    assertCompleteReferenceFacts({
      cell: input.cell,
      hiddenSnapshotTree: document.snapshotTree,
      facts: witness.facts,
    });
  }
  return Object.freeze({ outcome: witness.kind, reasonCode: witness.reasonCode });
};

const assertProjectedRepresentation = (input: {
  cell: BrowserIrHoldoutZeroModelPreflightCell;
  binding: AdaptiveProductAbBinding;
  returned: CallToolResult;
  visible: CallToolResult;
  hidden: CallToolResult;
}): Readonly<{ factKind: 'schedule-slot' | 'cross-tree-label'; factCount: number }> => {
  if (input.returned === input.visible) {
    throw new Error(`${input.cell.cellId} opaque auto result was not projected.`);
  }
  const returnedText = resultText(input.returned, `${input.cell.cellId} projected snapshot`);
  const hiddenText = resultText(input.hidden, `${input.cell.cellId} boxed snapshot`);
  if (/\[box=/u.test(returnedText)) {
    throw new Error(`${input.cell.cellId} exposed raw boxes in its returned representation.`);
  }
  if (!/\[box=/u.test(hiddenText)) {
    throw new Error(`${input.cell.cellId} hidden snapshot retained no geometry.`);
  }
  const returnedDocument = parsePlaywrightInlineSnapshot(returnedText);
  const hiddenDocument = parsePlaywrightInlineSnapshot(hiddenText);
  if (returnedDocument === undefined || hiddenDocument === undefined) {
    throw new Error(`${input.cell.cellId} returned no inline study snapshot.`);
  }
  const facts = parseAdaptiveFacts(returnedText);
  const study = adaptiveAccuracyHoldoutCases[input.cell.caseId];
  const factKind = input.cell.family === 'schedule-coordinate'
    ? 'schedule-slot' as const
    : 'cross-tree-label' as const;
  if (
    facts.length !== study.targetIds.length ||
    facts.some((fact) => fact.kind !== factKind) ||
    new Set(facts.map(({ ref }) => ref)).size !== facts.length
  ) throw new Error(`${input.cell.cellId} projected an incomplete or wrong fact family.`);
  if (
    input.binding.family !== input.cell.family ||
    input.binding.policyVersion !== expectedPolicyVersion(input.cell.family)
  ) throw new Error(`${input.cell.cellId} product fact provenance drifted.`);
  const hiddenNodes = parsePlaywrightSnapshotNodes(hiddenDocument.snapshotTree);
  const returnedNodes = parsePlaywrightSnapshotNodes(returnedDocument.snapshotTree);
  for (const fact of facts) {
    const hiddenMatches = hiddenNodes.filter(({ ref }) => ref === fact.ref);
    const returnedMatches = returnedNodes.filter(({ ref }) => ref === fact.ref);
    if (
      hiddenMatches.length !== 1 || hiddenMatches[0]!.box === undefined ||
      returnedMatches.length !== 1 || returnedMatches[0]!.box !== undefined
    ) throw new Error(`${input.cell.cellId} fact does not use one current boxed-snapshot ref.`);
  }
  const expectedTarget = expectedAdaptiveAccuracyHoldoutTarget(
    input.cell.caseId, input.cell.worldId,
  );
  const expectedIndex = study.targetIds.indexOf(expectedTarget);
  const hiddenCandidates = hiddenNodes.filter((node) =>
    node.role === 'button' && node.ref !== undefined && node.name === study.actionName);
  const expectedRef = hiddenCandidates[expectedIndex]?.ref;
  const requestedFacts = facts.filter((fact) =>
    relationMatches(input.cell.family, fact.attributes, study.requestedRelation));
  if (
    hiddenCandidates.length !== study.targetIds.length || expectedRef === undefined ||
    requestedFacts.length !== 1 || requestedFacts[0]!.ref !== expectedRef
  ) throw new Error(`${input.cell.cellId} requested relation is not bound to its current ref.`);
  return Object.freeze({ factKind, factCount: facts.length });
};

const assertPassthroughRepresentation = (input: {
  cell: BrowserIrHoldoutZeroModelPreflightCell;
  returned: CallToolResult;
  visible: RetainedRawCall;
}): void => {
  if (
    input.returned !== input.visible.result ||
    resultBytes(input.returned) !== input.visible.resultBytesAtRawBoundary
  ) {
    throw new Error(`${input.cell.cellId} did not preserve raw result identity and bytes.`);
  }
  const text = resultText(input.returned, `${input.cell.cellId} passthrough snapshot`);
  if (/\[box=/u.test(text) || parseAdaptiveFacts(text).length !== 0) {
    throw new Error(`${input.cell.cellId} passthrough representation was rewritten.`);
  }
  if (input.cell.mode === 'auto' && input.cell.worldId.startsWith('semantic-')) {
    const study = adaptiveAccuracyHoldoutCases[input.cell.caseId];
    const document = parsePlaywrightInlineSnapshot(text);
    if (document === undefined) throw new Error(`${input.cell.cellId} has no semantic snapshot.`);
    const candidates = parsePlaywrightSnapshotNodes(document.snapshotTree).filter((node) =>
      node.role === 'button' && node.ref !== undefined &&
      node.name?.endsWith(study.actionName));
    const expectedTarget = expectedAdaptiveAccuracyHoldoutTarget(
      input.cell.caseId, input.cell.worldId,
    );
    const expected = candidates[study.targetIds.indexOf(expectedTarget)];
    const relation = study.requestedRelation;
    const semanticallyBound = expected?.name !== undefined &&
      (relation.kind === 'schedule-coordinate'
        ? expected.name.includes(relation.resource) && expected.name.includes(relation.slot)
        : expected.name.includes(relation.label));
    if (candidates.length !== study.targetIds.length || !semanticallyBound) {
      throw new Error(`${input.cell.cellId} semantic control is not self-sufficient.`);
    }
  }
};

const assertRawResultUnchanged = (call: RetainedRawCall, label: string): void => {
  if (resultBytes(call.result) !== call.resultBytesAtRawBoundary) {
    throw new Error(`${label} raw MCP result mutated after its raw return boundary.`);
  }
};

const assertNetworkAudit = (
  result: CallToolResult,
  origin: string,
  requiredUrls: readonly string[],
): number => {
  const text = resultText(result, 'Network request audit');
  const urls = text.match(/(?:https?|wss?):\/\/[^\s<>)\]]+/gu) ?? [];
  if (urls.length === 0) {
    throw new Error('Network request audit returned no observable page-request URLs.');
  }
  const observedUrls: URL[] = [];
  for (const rawUrl of urls) {
    let url: URL;
    try { url = new URL(rawUrl.replace(/[.,;]$/u, '')); } catch {
      throw new Error('Network audit returned a malformed absolute URL.');
    }
    if (url.origin !== origin) throw new Error(`External browser request detected: ${url.origin}.`);
    observedUrls.push(url);
  }
  const observedHrefs = new Set(observedUrls.map(({ href }) => href));
  if (requiredUrls.some((requiredUrl) => !observedHrefs.has(requiredUrl))) {
    throw new Error('Network request audit lacks its exact page-request positive control.');
  }
  return observedUrls.length;
};

const assertVisibleStudyRoute = (
  cell: BrowserIrHoldoutZeroModelPreflightCell,
  origin: string,
  visible: CallToolResult,
): void => {
  const document = parsePlaywrightInlineSnapshot(
    resultText(visible, `${cell.cellId} raw visible snapshot`),
  );
  const expected = `${origin}${adaptiveAccuracyHoldoutCases[cell.caseId].path}`;
  if (document?.pageUrl !== expected) {
    throw new Error(`${cell.cellId} did not snapshot its exact stable bound route.`);
  }
};

const requiredTools = Object.freeze([
  'browser_navigate',
  'browser_snapshot',
  'browser_type',
  'browser_click',
  'browser_network_requests',
] as const);

const assertCatalog = (catalog: ListToolsResult): void => {
  const names = new Set(catalog.tools.map(({ name }) => name));
  const missing = requiredTools.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`Official MCP catalog lacks: ${missing.join(', ')}.`);
};

const assertExactTrace = (
  cell: BrowserIrHoldoutZeroModelPreflightCell,
  calls: readonly RetainedRawCall[],
): void => {
  const expectedCount = cell.mode === 'auto' && cell.worldId.startsWith('opaque-') ? 10 : 9;
  if (calls.length !== expectedCount) {
    throw new Error(`${cell.cellId} raw MCP trace has an unexpected call count.`);
  }
  const expectedNames = cell.mode === 'auto' && cell.worldId.startsWith('opaque-')
    ? [
        'browser_navigate', 'browser_snapshot', 'browser_type', 'browser_type',
        'browser_click', 'browser_network_requests', 'browser_navigate',
        'browser_snapshot', 'browser_snapshot', 'browser_network_requests',
      ]
    : [
        'browser_navigate', 'browser_snapshot', 'browser_type', 'browser_type',
        'browser_click', 'browser_network_requests', 'browser_navigate',
        'browser_snapshot', 'browser_network_requests',
      ];
  if (calls.some(({ request }, index) => request.name !== expectedNames[index])) {
    throw new Error(`${cell.cellId} raw MCP trace order drifted.`);
  }
  const clicks = calls.filter(({ request }) => request.name === 'browser_click');
  if (
    clicks.length !== 1 ||
    (clicks[0]!.request.arguments as Record<string, unknown> | undefined)?.['element'] !== 'Sign in'
  ) throw new Error(`${cell.cellId} trace contains a holdout or unexpected click.`);
  const modelSnapshotRequests = calls.filter(({ request }) =>
    exactRequest(request, 'browser_snapshot', {}));
  if (modelSnapshotRequests.length !== 2) {
    throw new Error(`${cell.cellId} must take one login and one visible study snapshot.`);
  }
  const hidden = calls.filter(({ request }) =>
    exactRequest(request, 'browser_snapshot', { boxes: true }));
  const expectedHidden = cell.mode === 'auto' && cell.worldId.startsWith('opaque-') ? 1 : 0;
  if (hidden.length !== expectedHidden) {
    throw new Error(`${cell.cellId} hidden snapshot trace drifted.`);
  }
  if (calls.some(({ request }) => ![
    'browser_navigate', 'browser_snapshot', 'browser_type', 'browser_click',
    'browser_network_requests',
  ].includes(request.name))) throw new Error(`${cell.cellId} used an unexpected browser tool.`);
};

export interface BrowserIrHoldoutZeroModelPreflightCapture {
  readonly cellId: string;
  readonly origin: string;
  readonly caseId: AdaptiveAccuracyHoldoutCaseId;
  readonly worldId: AdaptiveAccuracyHoldoutWorldId;
  readonly family: AdaptiveAccuracyHoldoutFamily;
  readonly mode: AdaptivePlaywrightMode;
  readonly binding: AdaptiveProductAbBinding;
  readonly catalogSha256: string;
  readonly outcome: 'disabled' | 'passthrough' | 'projected' | 'projection-unresolved';
  readonly hiddenCalls: 0 | 1;
  readonly rawCallCount: 9 | 10;
  readonly returnedRawIdentity: boolean;
  readonly returnedRawBytesUnchanged: boolean;
  readonly rawBoxesExposed: false;
  readonly factKind?: 'schedule-slot' | 'cross-tree-label' | undefined;
  readonly factCount: number;
  /** Evaluation-only proof; never returned to the model or product wrapper. */
  readonly relationStatus?:
    | 'demonstrated-recoverable'
    | 'recoverability-not-demonstrated'
    | undefined;
  readonly relationEvidence?:
    | 'product-complete-projection'
    | 'evaluation-reference-complete-projection'
    | 'evaluation-geometric-bijection-witness'
    | 'none'
    | undefined;
  readonly referenceProjectionOutcome?: 'resolved' | 'unresolved' | undefined;
  readonly referencePolicyVersion?:
    | 'schedule-coordinate-policy/1'
    | 'cross-tree-label-policy/1'
    | undefined;
  readonly referenceProjectionReasonCode?: string | undefined;
  readonly geometricWitnessOutcome?: 'resolved' | 'unresolved' | undefined;
  readonly geometricWitnessVersion?:
    typeof BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION | undefined;
  readonly geometricWitnessReasonCode?: string | undefined;
  readonly oracleBefore: BrowserIrHoldoutZeroOracleSnapshot;
  readonly oracleAfter: BrowserIrHoldoutZeroOracleSnapshot;
  readonly runtimeIdentity: BrowserIrHoldoutFreshRuntimeIdentity;
  /** Observed official MCP page-request log entries, not process-wide traffic. */
  readonly observedPageRequestCount: number;
  readonly modelCalls: 0;
  readonly providerCalls: 0;
  readonly observedExternalPageRequests: 0;
  readonly paidCalls: 0;
}

export interface BrowserIrHoldoutZeroModelPreflightResult {
  readonly schemaVersion: typeof BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_VERSION;
  readonly status: 'passed-zero-model-observed-loopback-page-requests-preflight';
  readonly captures: readonly BrowserIrHoldoutZeroModelPreflightCapture[];
  readonly summary: Readonly<{
    arms: number;
    pairs: number;
    fixedLoopbackOrigin: string;
    observedUniqueFixtureProcessPids: number;
    observedUniqueMcpProcessPids: number;
    freshInMemoryDatabaseConstructionAttestations: number;
    isolatedBrowserContextConstructionAttestations: number;
    initialPageConstructionAttestations: number;
    disabled: number;
    projected: number;
    projectionUnresolved: number;
    safeFallbacks: number;
    demonstratedRecoverableRelations: number;
    projectionMisses: number;
    unresolvedWithoutRecoverabilityProof: number;
    projectionRecallOnDemonstratedRecoverable: number;
    passthrough: number;
    hiddenCalls: number;
    databaseMutations: 0;
    holdoutActionClicks: 0;
    modelCalls: 0;
    providerCalls: 0;
    observedPageRequests: number;
    observedExternalPageRequests: 0;
    paidCalls: 0;
    score: null;
    claimAuthority: false;
  }>;
}

const attestationFields = Object.freeze([
  'databaseInstanceAttestationId',
  'browserContextConstructionAttestationId',
  'initialPageConstructionAttestationId',
] as const);

export async function runBrowserIrHoldoutZeroModelPreflight(
  dependencies: BrowserIrHoldoutZeroModelPreflightDependencies,
): Promise<BrowserIrHoldoutZeroModelPreflightResult> {
  const schedule = buildBrowserIrHoldoutZeroModelPreflightSchedule();
  const captures: BrowserIrHoldoutZeroModelPreflightCapture[] = [];
  let fixedLoopbackOrigin: string | undefined;
  const seenFixtureProcessPids = new Set<number>();
  const seenMcpProcessPids = new Set<number>();
  const seenAttestations = Object.fromEntries(
    attestationFields.map((field) => [field, new Set<string>()]),
  ) as Record<(typeof attestationFields)[number], Set<string>>;
  for (const cell of schedule) {
    const session = await dependencies.openArm({
      caseId: cell.caseId,
      worldId: cell.worldId,
      family: cell.family,
    });
    let broker: ReturnType<typeof createAdaptiveProductAbBroker> | undefined;
    let instrumented: InstrumentedRawClient | undefined;
    let primaryError: unknown;
    try {
      const origin = exactLoopbackOrigin(session.origin);
      if (fixedLoopbackOrigin === undefined) fixedLoopbackOrigin = origin;
      else if (origin !== fixedLoopbackOrigin) {
        throw new Error(`${cell.cellId} drifted from the prospectively selected loopback origin.`);
      }
      for (const [label, value, seen] of [
        ['fixture process PID', session.runtimeIdentity.fixtureProcessPid,
          seenFixtureProcessPids],
        ['MCP process PID', session.runtimeIdentity.mcpProcessPid, seenMcpProcessPids],
      ] as const) {
        if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) {
          throw new Error(`${cell.cellId} did not observe a unique positive ${label}.`);
        }
        seen.add(value);
      }
      for (const field of attestationFields) {
        const value = session.runtimeIdentity[field];
        if (
          typeof value !== 'string' || value.length < 1 ||
          seenAttestations[field].has(value)
        ) {
          throw new Error(`${cell.cellId} lacks a unique ${field}.`);
        }
        seenAttestations[field].add(value);
      }
      instrumented = instrumentRawClient(session.rawClient);
      const events: AdaptivePlaywrightTelemetryEvent[] = [];
      broker = createAdaptiveProductAbBroker(instrumented.client, {
        mode: cell.mode,
        family: cell.family,
        telemetry: { onEvent: (event) => events.push(event) },
      });
      assertProductBinding(cell, broker.binding);
      const catalog = await broker.listTools();
      assertCatalog(catalog);
      if (
        instrumented.lists.length !== 1 || catalog !== instrumented.lists[0]!.result ||
        resultBytes(catalog) !== instrumented.lists[0]!.resultBytesAtRawBoundary
      ) {
        throw new Error(`${cell.cellId} product path did not preserve raw catalog identity.`);
      }
      await authenticate(broker, origin);
      const loginNetworkAudit = await broker.callTool({
        name: 'browser_network_requests', arguments: { static: true },
      });
      const observedLoginRequestCount = assertNetworkAudit(
        loginNetworkAudit,
        origin,
        [`${origin}/app/login`],
      );
      const study = adaptiveAccuracyHoldoutCases[cell.caseId];
      assertSuccessful(await broker.callTool({
        name: 'browser_navigate', arguments: { url: `${origin}${study.path}` },
      }), `${cell.cellId} stable route navigation`);
      const oracleBefore = await session.verifyZeroOracle();
      assertZeroOracle(oracleBefore, `${cell.cellId} before snapshot`);
      const eventStart = events.length;
      const visibleRequest = { name: 'browser_snapshot', arguments: {} } as const;
      instrumented.beginStudy(visibleRequest);
      const returned = await broker.callTool(visibleRequest);
      const rawStudy = instrumented.endStudy();
      assertRawResultUnchanged(rawStudy.visible, `${cell.cellId} visible snapshot`);
      if (rawStudy.hidden !== undefined) {
        assertRawResultUnchanged(rawStudy.hidden, `${cell.cellId} hidden snapshot`);
      }
      assertSuccessful(returned, `${cell.cellId} study snapshot`);
      assertVisibleStudyRoute(cell, origin, rawStudy.visible.result);
      if (events.length !== eventStart + 1) {
        throw new Error(`${cell.cellId} study snapshot emitted other than one product event.`);
      }
      const event = events[eventStart]!;
      const opaqueAuto = cell.mode === 'auto' && cell.worldId.startsWith('opaque-');
      const semanticAuto = cell.mode === 'auto' && cell.worldId.startsWith('semantic-');
      const expectedNonOpaqueOutcome = cell.mode === 'off'
        ? 'disabled' as const
        : 'passthrough' as const;
      const opaqueOutcome = event.outcome === 'projected' ||
        event.outcome === 'projection-unresolved'
        ? event.outcome
        : undefined;
      const observedOutcome = opaqueAuto ? opaqueOutcome : expectedNonOpaqueOutcome;
      if (
        event.mode !== cell.mode || event.operation !== 'snapshot' ||
        observedOutcome === undefined || event.outcome !== observedOutcome ||
        event.hiddenCalls !== (opaqueAuto ? 1 : 0)
      ) throw new Error(
        `${cell.cellId} product telemetry drifted from its assigned arm: ` +
        `expected=${stableJson({
          mode: cell.mode,
          operation: 'snapshot',
          outcome: opaqueAuto
            ? ['projected', 'projection-unresolved']
            : expectedNonOpaqueOutcome,
          hiddenCalls: opaqueAuto ? 1 : 0,
        })}; actual=${stableJson(event)}.`,
      );
      if (!Object.isFrozen(event)) {
        throw new Error(`${cell.cellId} product telemetry event is not immutable.`);
      }
      if (rawStudy.hidden !== undefined && !exactRequest(
        rawStudy.hidden.request, 'browser_snapshot', { boxes: true },
      )) throw new Error(`${cell.cellId} hidden call was not exact {boxes:true}.`);
      if (rawStudy.hidden?.options !== undefined) {
        throw new Error(`${cell.cellId} hidden snapshot unexpectedly changed request options.`);
      }
      if ((rawStudy.hidden !== undefined) !== opaqueAuto) {
        throw new Error(`${cell.cellId} hidden call count drifted.`);
      }
      let factKind: 'schedule-slot' | 'cross-tree-label' | undefined;
      let factCount = 0;
      const reference = opaqueAuto
        ? await evaluateReferenceRecoverability({
            cell,
            visible: rawStudy.visible.result,
            hidden: rawStudy.hidden!.result,
          })
        : undefined;
      const geometricWitness = opaqueAuto
        ? evaluateGeometricWitness({ cell, hidden: rawStudy.hidden!.result })
        : undefined;
      if (opaqueAuto && observedOutcome === 'projected') {
        const projection = assertProjectedRepresentation({
          cell,
          binding: broker.binding,
          returned,
          visible: rawStudy.visible.result,
          hidden: rawStudy.hidden!.result,
        });
        factKind = projection.factKind;
        factCount = projection.factCount;
      } else {
        assertPassthroughRepresentation({ cell, returned, visible: rawStudy.visible });
      }
      const studyUrl = `${origin}${study.path}`;
      const networkAudit = await broker.callTool({
        name: 'browser_network_requests', arguments: { static: true },
      });
      const observedStudyRequestCount = assertNetworkAudit(
        networkAudit,
        origin,
        [studyUrl],
      );
      const observedPageRequestCount =
        observedLoginRequestCount + observedStudyRequestCount;
      const oracleAfter = await session.verifyZeroOracle();
      assertZeroOracle(oracleAfter, `${cell.cellId} after snapshot`);
      assertExactTrace(cell, instrumented.calls);
      const returnedText = resultText(returned, `${cell.cellId} returned snapshot`);
      captures.push(Object.freeze({
        cellId: cell.cellId,
        origin,
        caseId: cell.caseId,
        worldId: cell.worldId,
        family: cell.family,
        mode: cell.mode,
        binding: broker.binding,
        catalogSha256: sha256(instrumented.lists[0]!.resultBytesAtRawBoundary),
        outcome: observedOutcome,
        hiddenCalls: event.hiddenCalls,
        rawCallCount: instrumented.calls.length as 9 | 10,
        returnedRawIdentity: returned === rawStudy.visible.result,
        returnedRawBytesUnchanged:
          resultBytes(returned) === rawStudy.visible.resultBytesAtRawBoundary,
        rawBoxesExposed: false,
        ...(factKind === undefined ? {} : { factKind }),
        factCount,
        ...(reference === undefined
          ? {}
          : {
              relationStatus: observedOutcome === 'projected' ||
                  geometricWitness!.outcome === 'resolved' || reference.outcome === 'resolved'
                ? 'demonstrated-recoverable' as const
                : 'recoverability-not-demonstrated' as const,
              relationEvidence: observedOutcome === 'projected'
                ? 'product-complete-projection' as const
                : geometricWitness!.outcome === 'resolved'
                  ? 'evaluation-geometric-bijection-witness' as const
                : reference.outcome === 'resolved'
                  ? 'evaluation-reference-complete-projection' as const
                  : 'none' as const,
              referenceProjectionOutcome: reference.outcome,
              referencePolicyVersion: reference.policyVersion,
              referenceProjectionReasonCode: reference.reasonCode,
              geometricWitnessOutcome: geometricWitness!.outcome,
              geometricWitnessVersion: BROWSERIR_GEOMETRIC_BIJECTION_WITNESS_VERSION,
              geometricWitnessReasonCode: geometricWitness!.reasonCode,
            }),
        oracleBefore: Object.freeze({ ...oracleBefore }),
        oracleAfter: Object.freeze({ ...oracleAfter }),
        runtimeIdentity: Object.freeze({ ...session.runtimeIdentity }),
        observedPageRequestCount,
        modelCalls: 0,
        providerCalls: 0,
        observedExternalPageRequests: 0,
        paidCalls: 0,
      }));
      if (/\[box=/u.test(returnedText)) {
        throw new Error(`${cell.cellId} returned raw geometry despite its capture contract.`);
      }
      if (semanticAuto && returned !== rawStudy.visible.result) {
        throw new Error(`${cell.cellId} semantic auto control lost raw identity.`);
      }
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      await broker?.dispose().catch((error) => cleanupErrors.push(error));
      try { instrumented?.restore(); } catch (error) { cleanupErrors.push(error); }
      await session.close().catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
          `${cell.cellId} arm cleanup failed.`,
        );
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }
  if (captures.length !== BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_ARM_COUNT) {
    throw new Error('Holdout preflight did not capture all assigned arms.');
  }
  if (fixedLoopbackOrigin === undefined) {
    throw new Error('Holdout preflight acquired no fixed loopback origin.');
  }
  const catalogHashes = new Set(captures.map(({ catalogSha256 }) => catalogSha256));
  if (catalogHashes.size !== 1) throw new Error('Non-treatment tool catalog drifted across arms.');
  for (const caseId of ADAPTIVE_ACCURACY_HOLDOUT_CASE_IDS) {
    for (const worldId of ADAPTIVE_ACCURACY_HOLDOUT_WORLD_IDS) {
      const pair = captures.filter((capture) =>
        capture.caseId === caseId && capture.worldId === worldId);
      const off = pair.find(({ mode }) => mode === 'off');
      const auto = pair.find(({ mode }) => mode === 'auto');
      if (
        pair.length !== 2 || off === undefined || auto === undefined ||
        stableJson(bindingWithoutMode(off.binding)) !== stableJson(bindingWithoutMode(auto.binding))
      ) throw new Error(`${caseId}/${worldId} product bindings differ beyond mode.`);
    }
  }
  const opaqueAutoCaptures = captures.filter(({ mode, worldId }) =>
    mode === 'auto' && worldId.startsWith('opaque-'));
  const demonstratedRecoverable = opaqueAutoCaptures.filter(({ relationStatus }) =>
    relationStatus === 'demonstrated-recoverable');
  const projectionMisses = opaqueAutoCaptures.filter(({ outcome, relationStatus }) =>
    outcome === 'projection-unresolved' &&
    relationStatus === 'demonstrated-recoverable').length;
  const summary = Object.freeze({
    arms: captures.length,
    pairs: BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_PAIR_COUNT,
    fixedLoopbackOrigin,
    observedUniqueFixtureProcessPids: seenFixtureProcessPids.size,
    observedUniqueMcpProcessPids: seenMcpProcessPids.size,
    freshInMemoryDatabaseConstructionAttestations:
      seenAttestations.databaseInstanceAttestationId.size,
    isolatedBrowserContextConstructionAttestations:
      seenAttestations.browserContextConstructionAttestationId.size,
    initialPageConstructionAttestations:
      seenAttestations.initialPageConstructionAttestationId.size,
    disabled: captures.filter(({ outcome }) => outcome === 'disabled').length,
    projected: captures.filter(({ outcome }) => outcome === 'projected').length,
    projectionUnresolved:
      captures.filter(({ outcome }) => outcome === 'projection-unresolved').length,
    safeFallbacks:
      captures.filter(({ outcome }) => outcome === 'projection-unresolved').length,
    demonstratedRecoverableRelations: demonstratedRecoverable.length,
    projectionMisses,
    unresolvedWithoutRecoverabilityProof: opaqueAutoCaptures.filter(({ outcome, relationStatus }) =>
      outcome === 'projection-unresolved' &&
      relationStatus === 'recoverability-not-demonstrated').length,
    projectionRecallOnDemonstratedRecoverable: demonstratedRecoverable.length === 0
      ? 1
      : demonstratedRecoverable.filter(({ outcome }) => outcome === 'projected').length /
        demonstratedRecoverable.length,
    passthrough: captures.filter(({ outcome }) => outcome === 'passthrough').length,
    hiddenCalls: captures.reduce((sum, capture) => sum + capture.hiddenCalls, 0),
    databaseMutations: 0 as const,
    holdoutActionClicks: 0 as const,
    modelCalls: 0 as const,
    providerCalls: 0 as const,
    observedPageRequests: captures.reduce(
      (sum, capture) => sum + capture.observedPageRequestCount,
      0,
    ),
    observedExternalPageRequests: 0 as const,
    paidCalls: 0 as const,
    score: null,
    claimAuthority: false as const,
  });
  if (
    summary.arms !== BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_ARM_COUNT ||
    summary.pairs !== BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_PAIR_COUNT ||
    summary.observedUniqueFixtureProcessPids !== summary.arms ||
    summary.observedUniqueMcpProcessPids !== summary.arms ||
    summary.freshInMemoryDatabaseConstructionAttestations !== summary.arms ||
    summary.isolatedBrowserContextConstructionAttestations !== summary.arms ||
    summary.initialPageConstructionAttestations !== summary.arms ||
    summary.disabled !== summary.pairs ||
    summary.passthrough !== summary.pairs / 2 ||
    summary.hiddenCalls !== summary.pairs / 2 ||
    captures.filter(({ outcome }) => outcome === 'disabled').length !== summary.disabled ||
    captures.filter(({ outcome }) => outcome === 'projected').length !== summary.projected ||
    captures.filter(({ outcome }) => outcome === 'projection-unresolved').length !==
      summary.projectionUnresolved ||
    summary.projected + summary.projectionUnresolved !== summary.pairs / 2 ||
    summary.safeFallbacks !== summary.projectionUnresolved ||
    summary.projectionMisses + summary.unresolvedWithoutRecoverabilityProof !==
      summary.projectionUnresolved ||
    opaqueAutoCaptures.length !== summary.pairs / 2 ||
    captures.filter(({ outcome }) => outcome === 'passthrough').length !== summary.passthrough ||
    captures.reduce((sum, capture) => sum + capture.hiddenCalls, 0) !== summary.hiddenCalls
  ) throw new Error('Holdout preflight aggregate route counts drifted.');
  return Object.freeze({
    schemaVersion: BROWSERIR_HOLDOUT_ZERO_MODEL_PREFLIGHT_VERSION,
    status: 'passed-zero-model-observed-loopback-page-requests-preflight',
    captures: Object.freeze(captures),
    summary,
  });
}
