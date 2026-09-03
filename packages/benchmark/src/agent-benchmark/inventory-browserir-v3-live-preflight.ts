import type { CallToolResult } from '@modelcontextprotocol/client';
import type {
  AdaptivePlaywrightTelemetryEvent,
} from 'browserir-mcp';
import {
  INVENTORY_BROWSERIR_V3_CASE_IDS,
  INVENTORY_BROWSERIR_V3_CATALOG_SHA256,
  INVENTORY_BROWSERIR_V3_WORLD_IDS,
  expectedInventoryBrowserIrV3Target,
  inventoryBrowserIrV3Cases,
  inventoryBrowserIrV3RelationForTarget,
  startAppServer,
  verifyInventoryBrowserIrV3Selection,
  type InventoryBrowserIrV3CaseId,
  type InventoryBrowserIrV3Family,
  type InventoryBrowserIrV3RequestedRelation,
  type InventoryBrowserIrV3WorldId,
} from '@think-dom/fixture-app';

import {
  createAdaptiveProductAbBroker,
  type AdaptiveProductAbBinding,
} from './adaptive-product-ab-broker.js';
import { startOfficialBrowserIrMcp } from './official-playwright-mcp-live.js';
import {
  assertSuccessful,
  authenticate,
  parseAdaptiveFacts,
  resultText,
  type ParsedAdaptiveFact,
} from './playwright-mcp-live-preflight-helpers.js';
import {
  parsePlaywrightInlineSnapshot,
  parsePlaywrightSnapshotNodes,
} from './playwright-snapshot-document.js';

export const INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_VERSION =
  'inventory-browserir-v3-live-preflight/1' as const;

export const INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_CELL_COUNT =
  INVENTORY_BROWSERIR_V3_CASE_IDS.length * INVENTORY_BROWSERIR_V3_WORLD_IDS.length;

export interface InventoryBrowserIrV3PreflightCell {
  readonly ordinal: number;
  readonly cellId: string;
  readonly caseId: InventoryBrowserIrV3CaseId;
  readonly worldId: InventoryBrowserIrV3WorldId;
  readonly family: InventoryBrowserIrV3Family;
}

export function buildInventoryBrowserIrV3PreflightSchedule():
readonly InventoryBrowserIrV3PreflightCell[] {
  return Object.freeze(INVENTORY_BROWSERIR_V3_CASE_IDS.flatMap((caseId) =>
    INVENTORY_BROWSERIR_V3_WORLD_IDS.map((worldId) => ({
      caseId,
      worldId,
      family: inventoryBrowserIrV3Cases[caseId].familyId,
    }))).map((cell, ordinal) => Object.freeze({
      ordinal,
      cellId: `inventory-v3-${String(ordinal + 1).padStart(2, '0')}`,
      ...cell,
    })));
}

const normalized = (value: string): string => value.trim().replace(/\s+/gu, ' ').toLowerCase();

const requestedValues = (
  relation: InventoryBrowserIrV3RequestedRelation,
): readonly string[] => {
  switch (relation.kind) {
    case 'grid-coordinate': return [relation.row, relation.column];
    case 'schedule-coordinate': return [relation.resource, relation.slot];
    case 'cross-tree-label': return [relation.label];
  }
};

const expectedFactKind = (family: InventoryBrowserIrV3Family): string => {
  switch (family) {
    case 'grid-coordinate': return 'grid-cell';
    case 'schedule-coordinate': return 'schedule-slot';
    case 'cross-tree-label': return 'cross-tree-label';
  }
};

const factMatches = (
  fact: ParsedAdaptiveFact,
  relation: InventoryBrowserIrV3RequestedRelation,
): boolean => {
  switch (relation.kind) {
    case 'grid-coordinate':
      return fact.attributes['row'] === relation.row &&
        fact.attributes['column'] === relation.column;
    case 'schedule-coordinate':
      return fact.attributes['resource'] === relation.resource &&
        fact.attributes['slot'] === relation.slot;
    case 'cross-tree-label':
      return fact.attributes['label'] === relation.label;
  }
};

const relationAttributeKeys = (
  relation: InventoryBrowserIrV3RequestedRelation,
): readonly string[] => relation.kind === 'grid-coordinate'
  ? ['column', 'row']
  : relation.kind === 'schedule-coordinate'
    ? ['resource', 'slot']
    : ['label'];

const factExactlyMatches = (
  fact: ParsedAdaptiveFact,
  relation: InventoryBrowserIrV3RequestedRelation,
): boolean => {
  const actualKeys = Object.keys(fact.attributes).sort();
  const expectedKeys = [...relationAttributeKeys(relation)].sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    factMatches(fact, relation);
};

interface OrderedRefCandidate {
  readonly ref: string;
  readonly name?: string | undefined;
}

/**
 * Validate the complete current-ref -> relation bijection in DOM/snapshot
 * order, then return the exact ref requested by the checked-in case contract.
 */
export function validateInventoryBrowserIrV3ProjectedMapping(
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
  candidates: readonly OrderedRefCandidate[],
  facts: readonly ParsedAdaptiveFact[],
): Readonly<{ ref: string; factCount: number; factKind: string }> {
  const study = inventoryBrowserIrV3Cases[caseId];
  const factKind = expectedFactKind(study.familyId);
  if (
    candidates.length !== study.targetIds.length ||
    new Set(candidates.map(({ ref }) => ref)).size !== candidates.length ||
    facts.length !== study.targetIds.length ||
    new Set(facts.map(({ ref }) => ref)).size !== facts.length
  ) throw new Error('Inventory BrowserIR v3 projection is not a complete ref bijection.');

  for (const [index, candidate] of candidates.entries()) {
    const targetId = study.targetIds[index];
    if (targetId === undefined) {
      throw new Error('Inventory BrowserIR v3 candidate order exceeds the target catalog.');
    }
    const matchingFacts = facts.filter(({ ref }) => ref === candidate.ref);
    const relation = inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId);
    if (
      matchingFacts.length !== 1 || matchingFacts[0]!.kind !== factKind ||
      !factExactlyMatches(matchingFacts[0]!, relation)
    ) throw new Error('Inventory BrowserIR v3 projection contains an incorrect ref relation.');
  }

  const expectedTargetId = expectedInventoryBrowserIrV3Target(caseId, worldId);
  const requestedIndex = study.targetIds.indexOf(expectedTargetId);
  const requested = candidates[requestedIndex];
  if (requested === undefined) {
    throw new Error('Inventory BrowserIR v3 projection lacks the requested target ref.');
  }
  return Object.freeze({ ref: requested.ref, factCount: facts.length, factKind });
}

/** Validate every semantic action name before selecting the requested ref. */
export function validateInventoryBrowserIrV3SemanticMapping(
  caseId: InventoryBrowserIrV3CaseId,
  worldId: InventoryBrowserIrV3WorldId,
  candidates: readonly (OrderedRefCandidate & { readonly name: string })[],
): string {
  const study = inventoryBrowserIrV3Cases[caseId];
  if (
    candidates.length !== study.targetIds.length ||
    new Set(candidates.map(({ ref }) => ref)).size !== candidates.length
  ) throw new Error('Inventory BrowserIR v3 semantic mapping is incomplete.');
  for (const [index, candidate] of candidates.entries()) {
    const targetId = study.targetIds[index];
    if (targetId === undefined) {
      throw new Error('Inventory BrowserIR v3 semantic order exceeds the target catalog.');
    }
    const relation = inventoryBrowserIrV3RelationForTarget(caseId, worldId, targetId);
    const expectedName = normalized(
      [...requestedValues(relation), study.actionName].join(' '),
    );
    if (normalized(candidate.name) !== expectedName) {
      throw new Error('Inventory BrowserIR v3 semantic action has an incorrect relation name.');
    }
  }
  const expectedTargetId = expectedInventoryBrowserIrV3Target(caseId, worldId);
  const requested = candidates[study.targetIds.indexOf(expectedTargetId)];
  if (requested === undefined) {
    throw new Error('Inventory BrowserIR v3 semantic mapping lacks the requested target ref.');
  }
  return requested.ref;
}

const snapshotNodes = (result: CallToolResult, label: string) => {
  const document = parsePlaywrightInlineSnapshot(resultText(result, label));
  if (document === undefined) throw new Error(`${label} lacks an inline snapshot.`);
  return parsePlaywrightSnapshotNodes(document.snapshotTree);
};

const assertOpaqueOffIsAmbiguous = (
  result: CallToolResult,
  cell: InventoryBrowserIrV3PreflightCell,
): void => {
  const study = inventoryBrowserIrV3Cases[cell.caseId];
  const candidates = snapshotNodes(result, `${cell.cellId} off snapshot`).filter((node) =>
    node.role === 'button' && node.ref !== undefined && node.name === study.actionName);
  if (
    candidates.length !== study.targetIds.length ||
    parseAdaptiveFacts(resultText(result, `${cell.cellId} off snapshot`)).length !== 0
  ) throw new Error(`${cell.cellId} off snapshot was not the intended ambiguous control.`);
};

const projectedRef = (
  result: CallToolResult,
  cell: InventoryBrowserIrV3PreflightCell,
): Readonly<{ ref: string; factCount: number; factKind: string }> => {
  const text = resultText(result, `${cell.cellId} auto snapshot`);
  if (/\[box=/u.test(text)) throw new Error(`${cell.cellId} exposed raw geometry.`);
  const study = inventoryBrowserIrV3Cases[cell.caseId];
  const facts = parseAdaptiveFacts(text);
  const candidates = snapshotNodes(result, `${cell.cellId} auto snapshot`)
    .filter((node) => node.role === 'button' && node.ref !== undefined &&
      node.name === study.actionName)
    .map((node) => ({ ref: node.ref!, name: node.name }));
  try {
    return validateInventoryBrowserIrV3ProjectedMapping(
      cell.caseId,
      cell.worldId,
      candidates,
      facts,
    );
  } catch (error) {
    throw new Error(`${cell.cellId} returned an incomplete or incorrect projection.`, {
      cause: error,
    });
  }
};

const semanticRef = (
  result: CallToolResult,
  cell: InventoryBrowserIrV3PreflightCell,
): string => {
  const text = resultText(result, `${cell.cellId} semantic snapshot`);
  if (/\[box=/u.test(text) || parseAdaptiveFacts(text).length !== 0) {
    throw new Error(`${cell.cellId} semantic passthrough was rewritten.`);
  }
  const study = inventoryBrowserIrV3Cases[cell.caseId];
  const candidates = snapshotNodes(result, `${cell.cellId} semantic snapshot`).filter((node) =>
    node.role === 'button' && node.ref !== undefined && node.name !== undefined &&
      normalized(node.name).includes(normalized(study.actionName)))
    .map((node) => ({ ref: node.ref!, name: node.name! }));
  try {
    return validateInventoryBrowserIrV3SemanticMapping(
      cell.caseId,
      cell.worldId,
      candidates,
    );
  } catch (error) {
    throw new Error(`${cell.cellId} semantic relation mapping was incomplete or incorrect.`, {
      cause: error,
    });
  }
};

const expectedPolicyVersion = (
  family: InventoryBrowserIrV3Family,
): AdaptiveProductAbBinding['policyVersion'] => {
  switch (family) {
    case 'grid-coordinate': return 'grid-coordinate-policy/1';
    case 'schedule-coordinate': return 'schedule-coordinate-policy/3';
    case 'cross-tree-label': return 'cross-tree-label-policy/1';
  }
};

export interface InventoryBrowserIrV3LivePreflightCapture {
  readonly cellId: string;
  readonly caseId: InventoryBrowserIrV3CaseId;
  readonly worldId: InventoryBrowserIrV3WorldId;
  readonly family: InventoryBrowserIrV3Family;
  readonly offOutcome: 'disabled';
  readonly autoOutcome: 'projected' | 'passthrough';
  readonly hiddenCalls: 0 | 1;
  readonly policyVersion: AdaptiveProductAbBinding['policyVersion'];
  readonly factKind?: string | undefined;
  readonly factCount: number;
  readonly selectedRef: string;
  readonly expectedTargetId: string;
  readonly selectedTargetId: string;
  readonly exactOracleSuccess: true;
}

export interface InventoryBrowserIrV3LivePreflightResult {
  readonly schemaVersion: typeof INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_VERSION;
  readonly status: 'passed-live-browser-product-preflight';
  readonly catalogSha256: typeof INVENTORY_BROWSERIR_V3_CATALOG_SHA256;
  readonly captures: readonly InventoryBrowserIrV3LivePreflightCapture[];
  readonly summary: Readonly<{
    cases: 4;
    worldDefinitions: 4;
    caseWorlds: 16;
    offDisabled: 16;
    opaqueProjected: 8;
    semanticPassthrough: 8;
    hiddenSnapshotCalls: 8;
    exactOraclePasses: 16;
    wrongOrCollateralMutations: 0;
    modelCalls: 0;
    providerCalls: 0;
    score: null;
    claimAuthority: false;
  }>;
}

export async function runInventoryBrowserIrV3LivePreflight(
  options: Readonly<{ headless?: boolean }> = {},
): Promise<InventoryBrowserIrV3LivePreflightResult> {
  const captures: InventoryBrowserIrV3LivePreflightCapture[] = [];
  for (const cell of buildInventoryBrowserIrV3PreflightSchedule()) {
    const study = inventoryBrowserIrV3Cases[cell.caseId];
    const app = await startAppServer({
      apiLatencyMs: 0,
      pageLatencyMs: 0,
      enableControlApi: false,
      inventoryBrowserIrV3: { caseId: cell.caseId, worldId: cell.worldId },
    });
    let mcp: Awaited<ReturnType<typeof startOfficialBrowserIrMcp>> | undefined;
    let off: ReturnType<typeof createAdaptiveProductAbBroker> | undefined;
    let auto: ReturnType<typeof createAdaptiveProductAbBroker> | undefined;
    let primaryError: unknown;
    try {
      mcp = await startOfficialBrowserIrMcp({
        origin: app.origin,
        headless: options.headless ?? true,
      });
      const offEvents: AdaptivePlaywrightTelemetryEvent[] = [];
      off = createAdaptiveProductAbBroker(mcp.client, {
        mode: 'off',
        family: cell.family,
        telemetry: { onEvent: (event) => offEvents.push(event) },
      });
      await authenticate(off, app.origin);
      assertSuccessful(await off.callTool({
        name: 'browser_navigate', arguments: { url: `${app.origin}${study.path}` },
      }), `${cell.cellId} navigation`);
      const offEventStart = offEvents.length;
      const offSnapshot = await off.callTool({ name: 'browser_snapshot', arguments: {} });
      const offEvent = offEvents[offEventStart];
      if (
        offEvents.length !== offEventStart + 1 || offEvent?.mode !== 'off' ||
        offEvent.operation !== 'snapshot' || offEvent.outcome !== 'disabled' ||
        offEvent.hiddenCalls !== 0
      ) throw new Error(`${cell.cellId} off-arm telemetry drifted.`);
      if (cell.worldId.startsWith('opaque-')) assertOpaqueOffIsAmbiguous(offSnapshot, cell);
      await off.dispose();
      off = undefined;

      const autoEvents: AdaptivePlaywrightTelemetryEvent[] = [];
      auto = createAdaptiveProductAbBroker(mcp.client, {
        mode: 'auto',
        family: cell.family,
        telemetry: { onEvent: (event) => autoEvents.push(event) },
      });
      if (
        auto.binding.family !== cell.family ||
        auto.binding.policyVersion !== expectedPolicyVersion(cell.family)
      ) throw new Error(`${cell.cellId} first-party policy binding drifted.`);
      const autoSnapshot = await auto.callTool({ name: 'browser_snapshot', arguments: {} });
      const autoEvent = autoEvents[0];
      const opaque = cell.worldId.startsWith('opaque-');
      const expectedOutcome = opaque ? 'projected' : 'passthrough';
      const expectedHiddenCalls = opaque ? 1 : 0;
      if (
        autoEvents.length !== 1 || autoEvent?.mode !== 'auto' ||
        autoEvent.operation !== 'snapshot' || autoEvent.outcome !== expectedOutcome ||
        autoEvent.hiddenCalls !== expectedHiddenCalls || !Object.isFrozen(autoEvent)
      ) throw new Error(
        `${cell.cellId} auto-arm telemetry drifted: expected ${expectedOutcome}/` +
        `${expectedHiddenCalls}; actual ${JSON.stringify(autoEvents)}.`,
      );
      const selection = opaque
        ? projectedRef(autoSnapshot, cell)
        : { ref: semanticRef(autoSnapshot, cell), factCount: 0, factKind: undefined };
      const oracleBefore = verifyInventoryBrowserIrV3Selection(app.db, {
        caseId: cell.caseId,
        worldId: cell.worldId,
      });
      if (
        oracleBefore.passed || oracleBefore.mutationCount !== 0 ||
        oracleBefore.totalAuditMutationCount !== 0
      ) throw new Error(`${cell.cellId} was mutated before the study click.`);
      assertSuccessful(await auto.callTool({
        name: 'browser_click',
        arguments: { target: selection.ref, element: study.actionName },
      }), `${cell.cellId} exact selection`);
      const oracleAfter = verifyInventoryBrowserIrV3Selection(app.db, {
        caseId: cell.caseId,
        worldId: cell.worldId,
      });
      const selectedTargetId = oracleAfter.selectedTargetIds[0];
      const expectedTargetId = expectedInventoryBrowserIrV3Target(cell.caseId, cell.worldId);
      if (
        !oracleAfter.passed || selectedTargetId === undefined ||
        selectedTargetId !== expectedTargetId || oracleAfter.expectedTargetId !== expectedTargetId ||
        oracleAfter.mutationCount !== 1 || oracleAfter.collateralMutationCount !== 0 ||
        oracleAfter.totalCorpusMutationCount !== 1 || oracleAfter.otherAuditMutationCount !== 0 ||
        oracleAfter.totalAuditMutationCount !== 1
      ) throw new Error(`${cell.cellId} failed the exact one-shot database oracle.`);
      captures.push(Object.freeze({
        cellId: cell.cellId,
        caseId: cell.caseId,
        worldId: cell.worldId,
        family: cell.family,
        offOutcome: 'disabled',
        autoOutcome: expectedOutcome,
        hiddenCalls: expectedHiddenCalls,
        policyVersion: auto.binding.policyVersion,
        ...(selection.factKind === undefined ? {} : { factKind: selection.factKind }),
        factCount: selection.factCount,
        selectedRef: selection.ref,
        expectedTargetId,
        selectedTargetId,
        exactOracleSuccess: true,
      }));
    } catch (error) {
      primaryError = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      await auto?.dispose().catch((error) => cleanupErrors.push(error));
      await off?.dispose().catch((error) => cleanupErrors.push(error));
      await mcp?.close().catch((error) => cleanupErrors.push(error));
      await app.close().catch((error) => cleanupErrors.push(error));
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
          `${cell.cellId} cleanup failed.`,
        );
      }
    }
    if (primaryError !== undefined) throw primaryError;
  }
  if (captures.length !== INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_CELL_COUNT) {
    throw new Error('Inventory BrowserIR v3 preflight did not capture all case-world cells.');
  }
  const summary = Object.freeze({
    cases: INVENTORY_BROWSERIR_V3_CASE_IDS.length as 4,
    worldDefinitions: INVENTORY_BROWSERIR_V3_WORLD_IDS.length as 4,
    caseWorlds: INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_CELL_COUNT as 16,
    offDisabled: captures.filter(({ offOutcome }) => offOutcome === 'disabled').length as 16,
    opaqueProjected: captures.filter(({ autoOutcome }) => autoOutcome === 'projected').length as 8,
    semanticPassthrough: captures.filter(({ autoOutcome }) => autoOutcome === 'passthrough').length as 8,
    hiddenSnapshotCalls: captures.reduce<number>(
      (sum, { hiddenCalls }) => sum + hiddenCalls,
      0,
    ) as 8,
    exactOraclePasses: captures.filter(({ exactOracleSuccess }) => exactOracleSuccess).length as 16,
    wrongOrCollateralMutations: 0 as const,
    modelCalls: 0 as const,
    providerCalls: 0 as const,
    score: null,
    claimAuthority: false as const,
  });
  if (
    summary.offDisabled !== 16 || summary.opaqueProjected !== 8 ||
    summary.semanticPassthrough !== 8 || summary.hiddenSnapshotCalls !== 8 ||
    summary.exactOraclePasses !== 16
  ) throw new Error('Inventory BrowserIR v3 preflight route totals drifted.');
  return Object.freeze({
    schemaVersion: INVENTORY_BROWSERIR_V3_LIVE_PREFLIGHT_VERSION,
    status: 'passed-live-browser-product-preflight',
    catalogSha256: INVENTORY_BROWSERIR_V3_CATALOG_SHA256,
    captures: Object.freeze(captures),
    summary,
  });
}
