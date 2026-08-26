import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  adaptiveAccuracyHoldoutCases,
  type AdaptiveAccuracyHoldoutCaseId,
  type AdaptiveAccuracyHoldoutWorldId,
} from '@think-dom/fixture-app';
import { describe, expect, it } from 'vitest';

import { createOfficialBrowserIrHoldoutZeroModelDependencies } from
  '../src/agent-benchmark/browserir-holdout-zero-model-live.js';
import { witnessBrowserIrGeometricRecoverability } from
  '../src/agent-benchmark/browserir-recoverability-witness.js';
import {
  parsePlaywrightInlineSnapshot,
  parsePlaywrightSnapshotNodes,
} from '../src/agent-benchmark/playwright-snapshot-document.js';
import { takeScheduleProjectionDiagnostic } from
  '../../playwright-mcp/src/internal/schedule-projection-diagnostic.js';
import {
  createAdaptivePlaywrightTools,
  type AdaptivePlaywrightRawClient,
  type AdaptivePlaywrightTelemetryEvent,
} from '../../playwright-mcp/src/index.js';
import { createScheduleCoordinateReferencePolicy } from
  '../../playwright-mcp/src/reference-policies.js';

const optIn = process.env['BROWSERIR_RUN_RECOVERABILITY_WITNESS'] === '1'
  ? it
  : it.skip;

const resultText = (result: CallToolResult): string => result.content.flatMap((block) =>
  block.type === 'text' ? [block.text] : []).join('\n');

const refFor = (result: CallToolResult, role: string, name: string): string => {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`- ${role} "${escaped}"[^\\n]*\\[ref=([^\\]]+)\\]`, 'u')
    .exec(resultText(result));
  if (match?.[1] === undefined) throw new Error(`Missing ${role} ${name}.`);
  return match[1];
};

const unresolvedCells = Object.freeze([
  ['schedule/harbor-maintenance-rail', 'opaque-p0'],
  ['schedule/harbor-maintenance-rail', 'opaque-p1'],
  ['cross-tree/catalog-localization-queues', 'opaque-p1'],
] as const satisfies readonly (readonly [
  AdaptiveAccuracyHoldoutCaseId,
  AdaptiveAccuracyHoldoutWorldId,
])[]);

describe('Browser IR geometric recoverability witness against real renderer', () => {
  optIn('constructs and oracle-checks the known product fallback relations', async () => {
    const dependencies = createOfficialBrowserIrHoldoutZeroModelDependencies({ headless: true });
    const diagnostics: unknown[] = [];
    for (const [caseId, worldId] of unresolvedCells) {
      const study = adaptiveAccuracyHoldoutCases[caseId];
      const session = await dependencies.openArm({ caseId, worldId, family: study.familyId });
      try {
        await session.rawClient.callTool({
          name: 'browser_navigate', arguments: { url: `${session.origin}/app/login` },
        });
        const login = await session.rawClient.callTool({
          name: 'browser_snapshot', arguments: {},
        });
        await session.rawClient.callTool({
          name: 'browser_type',
          arguments: { target: refFor(login, 'textbox', 'Username'),
            element: 'Username', text: 'test' },
        });
        await session.rawClient.callTool({
          name: 'browser_type',
          arguments: { target: refFor(login, 'textbox', 'Password'),
            element: 'Password', text: 'test' },
        });
        await session.rawClient.callTool({
          name: 'browser_click',
          arguments: { target: refFor(login, 'button', 'Sign in'), element: 'Sign in' },
        });
        await session.rawClient.callTool({
          name: 'browser_navigate', arguments: { url: `${session.origin}${study.path}` },
        });
        let hidden: CallToolResult;
        let productDiagnostic: unknown = null;
        if (study.familyId === 'schedule-coordinate') {
          const hiddenSnapshots: CallToolResult[] = [];
          const events: AdaptivePlaywrightTelemetryEvent[] = [];
          const traced: AdaptivePlaywrightRawClient = {
            async callTool(...args) {
              const result = await session.rawClient.callTool(...args);
              if (
                args[0].name === 'browser_snapshot' &&
                args[0].arguments?.['boxes'] === true
              ) hiddenSnapshots.push(result);
              return result;
            },
            listTools: (...args) => session.rawClient.listTools(...args),
          };
          const policy = createScheduleCoordinateReferencePolicy();
          const tools = createAdaptivePlaywrightTools(traced, {
            mode: 'auto',
            policySet: policy,
            telemetry: { onEvent: (event) => events.push(event) },
          });
          try {
            await tools.callTool({ name: 'browser_snapshot', arguments: {} });
            hidden = hiddenSnapshots[0]!;
            productDiagnostic = {
              event: events[0],
              projection: takeScheduleProjectionDiagnostic(policy),
            };
          } finally {
            await tools.dispose();
          }
          if (hidden === undefined) throw new Error('Missing product boxed snapshot.');
        } else {
          hidden = await session.rawClient.callTool({
            name: 'browser_snapshot', arguments: { boxes: true },
          });
        }
        const document = parsePlaywrightInlineSnapshot(resultText(hidden));
        if (document === undefined) throw new Error('Missing boxed snapshot document.');
        const witness = witnessBrowserIrGeometricRecoverability({
          family: study.familyId,
          snapshotTree: document.snapshotTree,
          actionName: study.actionName,
          expectedFactCount: study.targetIds.length,
        });
        diagnostics.push({
          caseId,
          worldId,
          witness,
          productDiagnostic,
          relevantNodes: witness.kind === 'resolved'
            ? []
            : parsePlaywrightSnapshotNodes(document.snapshotTree)
                .filter(({ role }) => [
                  'region', 'form', 'group', 'list', 'heading', 'term',
                  'table', 'grid', 'rowheader', 'columnheader', 'button',
                ].includes(role))
                .map(({ index, parentIndex, role, name, ref, box }) => ({
                  index, parentIndex, role, name, ref, box,
                })),
        });
      } finally {
        await session.close();
      }
    }
    expect(diagnostics).toMatchObject([
      {
        caseId: 'schedule/harbor-maintenance-rail',
        worldId: 'opaque-p0',
        witness: {
          kind: 'resolved',
          reasonCode: 'schedule-nearest-centre-complete-bijection',
        },
        productDiagnostic: {
          event: { outcome: 'projected', hiddenCalls: 1 },
          projection: { reason: 'resolved' },
        },
      },
      {
        caseId: 'schedule/harbor-maintenance-rail',
        worldId: 'opaque-p1',
        witness: {
          kind: 'resolved',
          reasonCode: 'schedule-nearest-centre-complete-bijection',
        },
        productDiagnostic: {
          event: { outcome: 'projected', hiddenCalls: 1 },
          projection: { reason: 'resolved' },
        },
      },
      {
        caseId: 'cross-tree/catalog-localization-queues',
        worldId: 'opaque-p1',
        witness: {
          kind: 'unresolved',
          reasonCode: 'cross-tree-nearest-centre-not-complete-bijection',
        },
      },
    ]);
  }, 120_000);
});
