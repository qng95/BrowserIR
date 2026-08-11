import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import {
  BrowserIRRuntime,
  type BrowserCreateOptions,
  type CapabilityKind,
  type CompiledEntity,
  type CompiledView,
  type JsonValue,
  type ObservationResult,
  type RelationKind,
} from '@browserir/core';
import {
  createPlaywrightBrowserDriver,
  TABLE_STRUCTURE_POLICY,
} from '@browserir/playwright';

import {
  evaluateRepresentationReleaseGate,
  type RepresentationGateResult,
} from './gates.js';
import {
  measureIdentityStability,
  measureOmissionAccounting,
  measurePayload,
  measureRepresentation,
  type IdentityObservation,
  type OmissionCount,
  type RepresentationFacts,
  type RepresentationQualityMetrics,
  type TaskOutcomeRecord,
} from './metrics.js';
import {
  createEvaluationReport,
  renderEvaluationJson,
  renderEvaluationJUnit,
  renderEvaluationMarkdown,
  renderEvaluationNdjson,
  type EvaluationReport,
} from './report.js';
import type { BenchmarkEnvironment } from './environment.js';

const PROFILE: BrowserCreateOptions = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  locale: 'en-US',
  timezoneId: 'UTC',
};

const MAX_CHARACTERS = 250_000;
const CHOICE_IMPLEMENTATIONS = [
  'native',
  'aria',
  'roleless',
  'shadow',
] as const;

type ChoiceImplementation = (typeof CHOICE_IMPLEMENTATIONS)[number];

export const REPRESENTATION_SCENARIO_IDS = [
  'choice/native',
  'choice/aria',
  'choice/roleless',
  'choice/shadow',
  'relationships',
  'table-grid',
  'identity/baseline',
  'identity/stable-rerender',
  'identity/recycled-record',
  'omissions/scan-cap',
] as const;

export interface EntityMatch {
  kind?: CompiledEntity['kind'];
  role?: string;
  name?: string;
  text?: string;
  textIncludes?: string;
  value?: JsonValue;
  state?: Partial<CompiledEntity['state']>;
}

export interface RepresentationEntityContract {
  key: string;
  match: EntityMatch;
  capabilities: readonly CapabilityKind[];
}

export interface RepresentationAbstentionContract {
  key: string;
  entity: string;
  relationKind: RelationKind;
  requireUnnamed?: boolean;
}

export interface RepresentationCaseContract {
  id: string;
  entities: readonly RepresentationEntityContract[];
  relations: readonly {
    from: string;
    kind: RelationKind;
    to: string;
  }[];
  /** Only declared relation classes are scored; all facts in those classes count. */
  relationKinds: readonly RelationKind[];
  abstentions: readonly RepresentationAbstentionContract[];
}

export interface ScoredRepresentationCase {
  contractId: string;
  expected: RepresentationFacts;
  observed: RepresentationFacts;
  metrics: RepresentationQualityMetrics;
  /** Logical ground-truth key to opaque runtime ID, retained only as evidence. */
  matches: Record<string, string>;
}

export interface RepresentationScenarioResult {
  id: (typeof REPRESENTATION_SCENARIO_IDS)[number];
  payloadCharacters: number;
  payloadUtf8Bytes: number;
  payloadSha256: string;
}

export interface RepresentationGroundTruthSuiteOptions {
  runId?: string;
  headless?: boolean;
  environmentFingerprint?: string;
  environment?: BenchmarkEnvironment;
}

export interface RepresentationGroundTruthSuiteResult {
  report: EvaluationReport;
  releaseGate: RepresentationGateResult;
  releaseReady: boolean;
  scenarios: RepresentationScenarioResult[];
  /** One exact `{text, structured}` model payload per fixed-order scenario. */
  modelPayloadNdjson: string;
}

export interface RepresentationArtifactPaths {
  json: string;
  ndjson: string;
  markdown: string;
  junit: string;
  payloadNdjson: string;
}

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim();

const stableValue = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
    .join(',')}}`;
};

const matchesEntity = (
  entity: CompiledEntity,
  match: EntityMatch,
): boolean =>
  (match.kind === undefined || entity.kind === match.kind) &&
  (match.role === undefined || entity.role === match.role) &&
  (match.name === undefined ||
    (entity.name !== undefined && normalized(entity.name) === normalized(match.name))) &&
  (match.text === undefined ||
    (entity.text !== undefined && normalized(entity.text) === normalized(match.text))) &&
  (match.textIncludes === undefined ||
    (entity.text !== undefined &&
      normalized(entity.text).includes(normalized(match.textIncludes)))) &&
  (match.value === undefined || stableValue(entity.value) === stableValue(match.value)) &&
  Object.entries(match.state ?? {}).every(
    ([key, value]) =>
      stableValue(entity.state[key as keyof CompiledEntity['state']]) ===
      stableValue(value),
  );

const namespaced = (contractId: string, key: string): string =>
  `${contractId}/${key}`;

const unexpectedEntityKey = (
  contractId: string,
  entity: CompiledEntity,
  occurrence: number,
): string => {
  const semanticSignature = stableValue({
    kind: entity.kind,
    role: entity.role,
    name: entity.name === undefined ? undefined : normalized(entity.name),
    text: entity.text === undefined ? undefined : normalized(entity.text),
    value: entity.value,
  });
  const digest = createHash('sha256')
    .update(semanticSignature, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return namespaced(contractId, `unexpected-${digest}-${occurrence}`);
};

/**
 * Map an observation onto declared logical keys without consulting runtime IDs.
 * Runtime IDs are used only after semantic matching to join relation endpoints.
 */
export function scoreRepresentationCase(
  contract: RepresentationCaseContract,
  view: CompiledView,
): ScoredRepresentationCase {
  const runtimeByLogicalKey = new Map<string, CompiledEntity>();
  const claimedRuntimeIds = new Set<string>();
  for (const expected of contract.entities) {
    const candidates = view.structured.entities.filter(
      (entity) =>
        !claimedRuntimeIds.has(entity.ref.entityId) &&
        matchesEntity(entity, expected.match),
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    runtimeByLogicalKey.set(expected.key, candidate);
    claimedRuntimeIds.add(candidate.ref.entityId);
  }

  const logicalByRuntimeId = new Map<string, string>();
  for (const [logicalKey, entity] of runtimeByLogicalKey) {
    logicalByRuntimeId.set(
      entity.ref.entityId,
      namespaced(contract.id, logicalKey),
    );
  }

  const scoredRelationKinds = new Set(contract.relationKinds);
  const relevantRuntimeIds = new Set(logicalByRuntimeId.keys());
  for (const entity of view.structured.entities) {
    if (
      entity.capabilities.some((capability) => capability.enabled !== false) ||
      entity.kind === 'table' ||
      entity.kind === 'row' ||
      entity.kind === 'cell' ||
      entity.kind === 'option' ||
      (entity.role === 'label' && scoredRelationKinds.has('labels'))
    ) {
      relevantRuntimeIds.add(entity.ref.entityId);
    }
  }

  const inScopeRelations = view.structured.relations.filter((relation) =>
    scoredRelationKinds.has(relation.kind),
  );

  const occurrences = new Map<string, number>();
  for (const entity of view.structured.entities) {
    if (
      !relevantRuntimeIds.has(entity.ref.entityId) ||
      logicalByRuntimeId.has(entity.ref.entityId)
    ) {
      continue;
    }
    const signature = stableValue({
      kind: entity.kind,
      role: entity.role,
      name: entity.name,
      text: entity.text,
      value: entity.value,
    });
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    logicalByRuntimeId.set(
      entity.ref.entityId,
      unexpectedEntityKey(contract.id, entity, occurrence),
    );
  }

  const expected: RepresentationFacts = {
    entities: contract.entities.map((entity) =>
      namespaced(contract.id, entity.key),
    ),
    capabilities: contract.entities.flatMap((entity) =>
      entity.capabilities.map((capability) => ({
        entity: namespaced(contract.id, entity.key),
        capability,
      }))),
    relations: contract.relations.map((relation) => ({
      from: namespaced(contract.id, relation.from),
      kind: relation.kind,
      to: namespaced(contract.id, relation.to),
    })),
    abstentions: contract.abstentions.map((abstention) =>
      namespaced(contract.id, abstention.key),
    ),
  };

  const observedEntities = [...logicalByRuntimeId.values()];
  const entityByRuntimeId = new Map(
    view.structured.entities.map((entity) => [entity.ref.entityId, entity]),
  );
  const observed: RepresentationFacts = {
    entities: observedEntities,
    capabilities: [...logicalByRuntimeId].flatMap(
      ([runtimeId, logicalKey]) =>
        (entityByRuntimeId.get(runtimeId)?.capabilities ?? [])
          .filter((capability) => capability.enabled !== false)
          .map((capability) => ({
            entity: logicalKey,
            capability: capability.kind,
          })),
    ),
    relations: inScopeRelations.flatMap((relation) => {
      const from = logicalByRuntimeId.get(relation.from.entityId);
      const to = logicalByRuntimeId.get(relation.to.entityId);
      return from === undefined || to === undefined
        ? []
        : [{ from, kind: relation.kind, to }];
    }),
    abstentions: contract.abstentions.flatMap((abstention) => {
      const entity = runtimeByLogicalKey.get(abstention.entity);
      if (entity === undefined) return [];
      const hasForbiddenRelation = view.structured.relations.some(
        (relation) =>
          relation.kind === abstention.relationKind &&
          relation.to.entityId === entity.ref.entityId,
      );
      const hasForbiddenName =
        abstention.requireUnnamed === true && entity.name !== undefined;
      return hasForbiddenRelation || hasForbiddenName
        ? []
        : [namespaced(contract.id, abstention.key)];
    }),
  };

  return {
    contractId: contract.id,
    expected,
    observed,
    metrics: measureRepresentation(expected, observed),
    matches: Object.fromEntries(
      [...runtimeByLogicalKey].map(([key, entity]) => [
        key,
        entity.ref.entityId,
      ]),
    ),
  };
}

const choiceContract = (id: string): RepresentationCaseContract => ({
  id,
  entities: [
    {
      key: 'status',
      match: {
        kind: 'input',
        role: 'combobox',
        name: 'Customer Status',
        value: 'prospect',
        state: { visible: true, enabled: true, expanded: false },
      },
      capabilities: ['contextClick', 'focus', 'hover', 'select'],
    },
    ...([
      ['prospect', 'Prospect'],
      ['active', 'Active'],
      ['suspended', 'Suspended'],
    ] as const).map(([value, name]): RepresentationEntityContract => ({
      key: `option-${value}`,
      match: {
        kind: 'option',
        role: 'option',
        name,
        value,
        state: { selected: value === 'prospect' },
      },
      capabilities: [],
    })),
  ],
  relations: ['prospect', 'active', 'suspended'].map((value) => ({
    from: `option-${value}`,
    kind: 'option-of' as const,
    to: 'status',
  })),
  relationKinds: ['option-of'],
  abstentions: [],
});

const RELATIONSHIP_CONTRACT: RepresentationCaseContract = {
  id: 'relationships',
  entities: [
    {
      key: 'exact-label',
      match: { kind: 'text', role: 'label', text: 'Account email' },
      capabilities: [],
    },
    {
      key: 'exact-control',
      match: {
        kind: 'input',
        role: 'textbox',
        name: 'Account email',
        value: 'exact@example.test',
      },
      capabilities: ['contextClick', 'fill', 'focus', 'hover', 'press', 'type'],
    },
    {
      key: 'cross-label',
      match: { kind: 'text', role: 'label', text: 'Phone number' },
      capabilities: [],
    },
    {
      key: 'cross-control',
      match: {
        kind: 'input',
        role: 'textbox',
        name: 'Phone number',
        value: '+49 30 5550102',
      },
      capabilities: ['contextClick', 'fill', 'focus', 'hover', 'press', 'type'],
    },
    {
      key: 'ambiguous-control',
      match: { kind: 'input', value: 'ambiguous-seed' },
      capabilities: ['contextClick', 'fill', 'focus', 'hover', 'press', 'type'],
    },
  ],
  relations: [
    { from: 'exact-label', kind: 'labels', to: 'exact-control' },
    { from: 'cross-label', kind: 'labels', to: 'cross-control' },
  ],
  relationKinds: ['labels'],
  abstentions: [
    {
      key: 'ambiguous-label',
      entity: 'ambiguous-control',
      relationKind: 'labels',
      requireUnnamed: true,
    },
  ],
};

const buttonCapabilities = [
  'click',
  'contextClick',
  'doubleClick',
  'focus',
  'hover',
] as const satisfies readonly CapabilityKind[];

const TABLE_CONTRACT: RepresentationCaseContract = {
  id: 'table-grid',
  entities: [
    {
      key: 'native-table',
      match: { kind: 'table', role: 'table', name: 'Customer accounts' },
      capabilities: [],
    },
    {
      key: 'native-row',
      match: { kind: 'row', textIncludes: 'Ada Lovelace' },
      capabilities: [],
    },
    {
      key: 'native-name-cell',
      match: { kind: 'cell', text: 'Ada Lovelace' },
      capabilities: [],
    },
    {
      key: 'native-action-cell',
      match: { kind: 'cell', text: 'Open Ada account' },
      capabilities: [],
    },
    {
      key: 'native-action',
      match: { kind: 'control', role: 'button', name: 'Open Ada account' },
      capabilities: buttonCapabilities,
    },
    {
      key: 'aria-grid',
      match: {
        kind: 'table',
        role: 'grid',
        name: 'Inventory grid',
        value: { rowCount: 1, columnCount: 2 },
      },
      capabilities: [],
    },
    {
      key: 'aria-row',
      match: { kind: 'row', textIncludes: 'ST-77', value: { rowIndex: 1 } },
      capabilities: [],
    },
    {
      key: 'aria-stock-cell',
      match: { kind: 'cell', text: 'ST-77', value: { columnIndex: 1 } },
      capabilities: [],
    },
    {
      key: 'aria-action-cell',
      match: {
        kind: 'cell',
        text: 'Inspect stock 77',
        value: { columnIndex: 2 },
      },
      capabilities: [],
    },
    {
      key: 'aria-action',
      match: { kind: 'control', role: 'button', name: 'Inspect stock 77' },
      capabilities: buttonCapabilities,
    },
  ],
  relations: [
    { from: 'native-table', kind: 'contains', to: 'native-row' },
    { from: 'native-row', kind: 'row-of', to: 'native-table' },
    { from: 'native-row', kind: 'contains', to: 'native-name-cell' },
    { from: 'native-name-cell', kind: 'cell-of', to: 'native-row' },
    { from: 'native-row', kind: 'contains', to: 'native-action-cell' },
    { from: 'native-action-cell', kind: 'cell-of', to: 'native-row' },
    { from: 'native-action-cell', kind: 'contains', to: 'native-action' },
    { from: 'aria-grid', kind: 'contains', to: 'aria-row' },
    { from: 'aria-row', kind: 'row-of', to: 'aria-grid' },
    { from: 'aria-row', kind: 'contains', to: 'aria-stock-cell' },
    { from: 'aria-stock-cell', kind: 'cell-of', to: 'aria-row' },
    { from: 'aria-row', kind: 'contains', to: 'aria-action-cell' },
    { from: 'aria-action-cell', kind: 'cell-of', to: 'aria-row' },
    { from: 'aria-action-cell', kind: 'contains', to: 'aria-action' },
  ],
  relationKinds: ['contains', 'row-of', 'cell-of'],
  abstentions: [],
};

const documentPage = (title: string, body: string, script = ''): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font: 16px sans-serif; padding: 24px; }
      .choice-control { border: 1px solid #777; padding: 8px; width: 260px; }
      [role="listbox"][hidden], .choice-list[hidden] { display: none; }
      .exact-case { display: grid; grid-template-columns: 190px 280px; align-items: center; }
      .parallel, .ambiguous { position: relative; width: 520px; height: 58px; margin-top: 24px; }
      .label-tree, .control-tree { position: absolute; top: 0; }
      .label-tree { left: 0; width: 180px; }
      .control-tree { left: 220px; width: 280px; }
      .label-row { display: block; height: 44px; padding: 8px 0; box-sizing: border-box; }
      .control-row { display: block; width: 260px; height: 36px; box-sizing: border-box; }
      .ambiguous .candidate { position: absolute; left: 0; top: 8px; width: 180px; }
      .ambiguous input { position: absolute; left: 220px; top: 0; width: 260px; height: 36px; }
      table { border-collapse: collapse; margin-bottom: 24px; }
      td, [role="gridcell"] { border: 1px solid #999; min-width: 140px; padding: 6px; }
      [role="row"] { display: flex; }
    </style>
  </head>
  <body><main aria-label="Representation laboratory">${body}</main>${script}</body>
</html>`;

const choices = [
  ['Prospect', 'prospect'],
  ['Active', 'active'],
  ['Suspended', 'suspended'],
] as const;

const choiceOptions = (attributes: string): string =>
  choices
    .map(
      ([label, value]) =>
        `<div ${attributes} value="${value}" data-value="${value}" aria-selected="${value === 'prospect'}">${label}</div>`,
    )
    .join('');

const choiceFixture = (implementation: ChoiceImplementation): string => {
  if (implementation === 'native') {
    return documentPage(
      'Technology-neutral choice',
      `<label for="customer-status">Customer Status</label>
       <select id="customer-status">
         ${choices
           .map(
             ([label, value]) =>
               `<option value="${value}"${value === 'prospect' ? ' selected' : ''}>${label}</option>`,
           )
           .join('')}
       </select>`,
    );
  }
  if (implementation === 'aria') {
    return documentPage(
      'Technology-neutral choice',
      `<span id="status-label">Customer Status</span>
       <div class="choice-control" role="combobox" tabindex="0"
         aria-labelledby="status-label" aria-controls="status-options"
         aria-expanded="false" aria-valuetext="Prospect" value="prospect">Prospect</div>
       <div id="status-options" role="listbox" hidden>${choiceOptions('role="option"')}</div>`,
    );
  }
  if (implementation === 'roleless') {
    return documentPage(
      'Technology-neutral choice',
      `<span id="status-label">Customer Status</span>
       <div class="choice-control" tabindex="0" aria-labelledby="status-label"
         aria-haspopup="listbox" aria-controls="status-options"
         aria-expanded="false" aria-valuetext="Prospect" value="prospect">Prospect</div>
       <div id="status-options" class="choice-list" hidden>${choiceOptions('class="choice-option"')}</div>`,
    );
  }
  return documentPage(
    'Technology-neutral choice',
    `<customer-status-field></customer-status-field>
     <div id="status-options" role="listbox" hidden>${choiceOptions('role="option"')}</div>`,
    `<script>
      const host = document.querySelector('customer-status-field');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<span id="status-label">Customer Status</span>' +
        '<div class="choice-control" role="combobox" tabindex="0" ' +
        'aria-labelledby="status-label" aria-controls="status-options" ' +
        'aria-expanded="false" aria-valuetext="Prospect" value="prospect">Prospect</div>';
    </script>`,
  );
};

const relationshipFixture = (): string =>
  documentPage(
    'Semantic relationships',
    `<div class="exact-case">
       <div><label for="exact-account-email">Account email</label></div>
       <div><input id="exact-account-email" type="email" value="exact@example.test"></div>
     </div>
     <section aria-label="Contact details">
       <div class="parallel">
         <div class="label-tree"><span class="label-row">Phone number</span></div>
         <div class="control-tree"><input class="control-row" type="tel" value="+49 30 5550102"></div>
       </div>
     </section>
     <section aria-label="Ambiguous details">
       <div class="ambiguous">
         <span class="candidate">Reference</span>
         <span class="candidate">Reference</span>
         <input type="text" value="ambiguous-seed">
       </div>
     </section>`,
  );

const tableFixture = (): string =>
  documentPage(
    'Table and grid structure',
    `<table id="customer-accounts">
       <caption>Customer accounts</caption>
       <tbody><tr data-record-id="customer-101">
         <td>Ada Lovelace</td>
         <td><button type="button">Open Ada account</button></td>
       </tr></tbody>
     </table>
     <div role="grid" aria-label="Inventory grid" aria-rowcount="1" aria-colcount="2">
       <div role="row" aria-rowindex="1" data-row-id="stock-77">
         <div role="gridcell" aria-colindex="1">ST-77</div>
         <div role="gridcell" aria-colindex="2"><button type="button">Inspect stock 77</button></div>
       </div>
     </div>`,
  );

const identityFixture = (): string =>
  documentPage(
    'Identity lifecycle',
    `<div id="vehicle-grid" role="grid" aria-label="Vehicle records" aria-rowcount="10000" aria-colcount="2">
       <div id="record-row" role="row" aria-rowindex="501" data-record-id="vehicle-501">
         <div role="gridcell" aria-colindex="1" data-column-key="vehicle">Vehicle 501</div>
         <div role="gridcell" aria-colindex="2" data-column-key="status">Ready</div>
       </div>
     </div>
     <button id="stable" type="button">Stable rerender</button>
     <button id="recycle" type="button">Recycle record</button>`,
    `<script>
      let row = document.querySelector('#record-row');
      document.querySelector('#stable').addEventListener('click', () => {
        const replacement = row.cloneNode(true);
        replacement.querySelector('[data-column-key="status"]').textContent = 'Reserved';
        row.replaceWith(replacement);
        row = replacement;
      });
      document.querySelector('#recycle').addEventListener('click', () => {
        row.dataset.recordId = 'vehicle-9001';
        row.setAttribute('aria-rowindex', '9001');
        row.querySelector('[data-column-key="vehicle"]').textContent = 'Vehicle 9001';
        row.querySelector('[data-column-key="status"]').textContent = 'Sold';
      });
    </script>`,
  );

const cappedFixture = (): string =>
  documentPage(
    'Bounded structural scan',
    `<div role="grid" aria-label="Bounded result set">
       ${Array.from(
         { length: TABLE_STRUCTURE_POLICY.maxRows + 3 },
         (_, index) => `<div role="row" aria-rowindex="${index + 1}">
           <div role="gridcell" aria-colindex="1">Record ${index + 1}</div>
         </div>`,
       ).join('')}
     </div>`,
  );

interface RepresentationFixture {
  origin: string;
  close(): Promise<void>;
}

async function startRepresentationFixture(): Promise<RepresentationFixture> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    let content: string | undefined;
    if (url.pathname === '/choice') {
      const implementation = url.searchParams.get('implementation');
      if (
        implementation !== null &&
        CHOICE_IMPLEMENTATIONS.includes(implementation as ChoiceImplementation)
      ) {
        content = choiceFixture(implementation as ChoiceImplementation);
      }
    } else if (url.pathname === '/relationships') {
      content = relationshipFixture();
    } else if (url.pathname === '/tables') {
      content = tableFixture();
    } else if (url.pathname === '/identity') {
      content = identityFixture();
    } else if (url.pathname === '/capped') {
      content = cappedFixture();
    }
    if (content === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(content);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Representation fixture did not bind a TCP port.');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    },
  };
}

const exactMetrics = (metrics: RepresentationQualityMetrics): boolean =>
  [metrics.entities, metrics.capabilities, metrics.relations].every(
    (metric) => metric.falsePositive === 0 && metric.falseNegative === 0,
  ) &&
  metrics.correctAbstention.unexpected === 0 &&
  metrics.correctAbstention.missed === 0;

const combineFacts = (
  cases: readonly ScoredRepresentationCase[],
  side: 'expected' | 'observed',
): RepresentationFacts => ({
  entities: cases.flatMap((scored) => scored[side].entities),
  capabilities: cases.flatMap((scored) => scored[side].capabilities),
  relations: cases.flatMap((scored) => scored[side].relations),
  abstentions: cases.flatMap((scored) => scored[side].abstentions ?? []),
});

const task = (
  taskId: string,
  passed: boolean,
  failureReason: string,
): TaskOutcomeRecord =>
  passed
    ? { taskId, outcome: 'passed' }
    : { taskId, outcome: 'failed', reason: failureReason };

const uniqueEntity = (
  view: CompiledView,
  predicate: (entity: CompiledEntity) => boolean,
  description: string,
): CompiledEntity => {
  const matches = view.structured.entities.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}, received ${matches.length}.`);
  }
  return matches[0]!;
};

const identityObservations = (
  view: CompiledView,
  status: string,
  vehicle: string,
): IdentityObservation[] => [
  {
    logicalKey: 'vehicle-record',
    entityId: uniqueEntity(
      view,
      (entity) => entity.kind === 'row' && entity.text?.includes(vehicle) === true,
      `${vehicle} row`,
    ).ref.entityId,
  },
  {
    logicalKey: 'vehicle-cell',
    entityId: uniqueEntity(
      view,
      (entity) => entity.kind === 'cell' && entity.text === vehicle,
      `${vehicle} cell`,
    ).ref.entityId,
  },
  {
    logicalKey: 'status-cell',
    entityId: uniqueEntity(
      view,
      (entity) => entity.kind === 'cell' && entity.text === status,
      `${status} status cell`,
    ).ref.entityId,
  },
];

const performClick = async (
  runtime: BrowserIRRuntime,
  browserId: string,
  current: ObservationResult,
  name: string,
): Promise<ObservationResult> => {
  const target = uniqueEntity(
    current.view,
    (entity) =>
      entity.name === name &&
      entity.capabilities.some(
        (capability) => capability.kind === 'click' && capability.enabled !== false,
      ),
    `${name} action`,
  );
  const receipt = await runtime.act({
    browserId,
    pageId: current.view.pageId,
    expectedRevision: current.view.revision,
    action: { kind: 'click', target: target.ref },
    budget: { maxCharacters: MAX_CHARACTERS },
  });
  if (!receipt.dispatched) {
    throw new Error(`${name} was not dispatched: ${receipt.error?.code ?? receipt.status}.`);
  }
  return (
    receipt.observation ??
    runtime.observe({
      browserId,
      pageId: current.view.pageId,
      budget: { maxCharacters: MAX_CHARACTERS },
    })
  );
};

const caseFingerprint = (scored: ScoredRepresentationCase): string => {
  const prefix = `${scored.contractId}/`;
  const strip = (value: string): string =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return stableValue({
    entities: scored.observed.entities.map(strip).sort(),
    capabilities: scored.observed.capabilities
      .map(({ entity, capability }) => [strip(entity), capability])
      .sort(),
    relations: scored.observed.relations
      .map(({ from, kind, to }) => [strip(from), kind, strip(to)])
      .sort(),
  });
};

const defaultRunId = (): string =>
  `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;

export async function runRepresentationGroundTruthSuite(
  options: RepresentationGroundTruthSuiteOptions = {},
): Promise<RepresentationGroundTruthSuiteResult> {
  const fixture = await startRepresentationFixture();
  const runtime = new BrowserIRRuntime(
    createPlaywrightBrowserDriver({ headless: options.headless ?? true }),
  );
  let browserId: string | undefined;
  try {
    const created = await runtime.create(PROFILE);
    browserId = created.browserId;
    let revision = 0;
    const payloads: string[] = [];
    const scenarios: RepresentationScenarioResult[] = [];
    const record = (
      id: (typeof REPRESENTATION_SCENARIO_IDS)[number],
      observation: ObservationResult,
    ): void => {
      const payload = JSON.stringify({
        text: observation.view.text,
        structured: observation.view.structured,
      });
      const measured = measurePayload(payload);
      payloads.push(payload);
      scenarios.push({
        id,
        payloadCharacters: measured.characters,
        payloadUtf8Bytes: measured.utf8Bytes,
        payloadSha256: createHash('sha256').update(payload, 'utf8').digest('hex'),
      });
      revision = observation.view.revision;
    };
    const navigate = async (path: string): Promise<ObservationResult> =>
      runtime.navigate({
        browserId: created.browserId,
        pageId: created.initialPageId,
        expectedRevision: revision,
        url: `${fixture.origin}${path}`,
        budget: { maxCharacters: MAX_CHARACTERS },
      });

    const scoredCases: ScoredRepresentationCase[] = [];
    const choiceScores: ScoredRepresentationCase[] = [];
    for (const implementation of CHOICE_IMPLEMENTATIONS) {
      const observed = await navigate(`/choice?implementation=${implementation}`);
      record(`choice/${implementation}`, observed);
      const scored = scoreRepresentationCase(
        choiceContract(`choice/${implementation}`),
        observed.view,
      );
      choiceScores.push(scored);
      scoredCases.push(scored);
    }

    const relationships = await navigate('/relationships');
    record('relationships', relationships);
    const relationshipScore = scoreRepresentationCase(
      RELATIONSHIP_CONTRACT,
      relationships.view,
    );
    scoredCases.push(relationshipScore);

    const tables = await navigate('/tables');
    record('table-grid', tables);
    const tableScore = scoreRepresentationCase(TABLE_CONTRACT, tables.view);
    scoredCases.push(tableScore);

    let identity = await navigate('/identity');
    record('identity/baseline', identity);
    const baselineIdentity = identityObservations(
      identity.view,
      'Ready',
      'Vehicle 501',
    );
    identity = await performClick(
      runtime,
      created.browserId,
      identity,
      'Stable rerender',
    );
    record('identity/stable-rerender', identity);
    const stableIdentity = identityObservations(
      identity.view,
      'Reserved',
      'Vehicle 501',
    );
    const identityStability = measureIdentityStability(
      baselineIdentity,
      stableIdentity,
    );
    identity = await performClick(
      runtime,
      created.browserId,
      identity,
      'Recycle record',
    );
    record('identity/recycled-record', identity);
    const recycledIdentity = identityObservations(
      identity.view,
      'Sold',
      'Vehicle 9001',
    );
    const stableIds = new Set(stableIdentity.map(({ entityId }) => entityId));
    const recycledIds = recycledIdentity.map(({ entityId }) => entityId);
    const recycledWasReplaced = recycledIds.every(
      (entityId) => !stableIds.has(entityId),
    );

    const capped = await navigate('/capped');
    record('omissions/scan-cap', capped);
    const extraRows = 3;
    const knownOmissions: OmissionCount[] = [
      { category: 'entities:scan_cap', count: extraRows * 2 },
      { category: 'relations:scan_cap', count: extraRows * 4 },
    ];
    const reportedOmissions: OmissionCount[] = capped.view.structured.omissions
      .filter((omission) => omission.reason === 'scan_cap')
      .map((omission) => ({
        category: `${omission.kind}:${omission.reason}`,
        count: omission.count,
      }));
    const omissionAccounting = measureOmissionAccounting(
      knownOmissions,
      reportedOmissions,
    );

    const expected = combineFacts(scoredCases, 'expected');
    const observed = combineFacts(scoredCases, 'observed');
    const representation = {
      ...measureRepresentation(expected, observed),
      identityStability,
      omissionAccounting,
    };
    const releaseGate = evaluateRepresentationReleaseGate(representation);
    const tasks: TaskOutcomeRecord[] = [
      ...choiceScores.map((scored) =>
        task(
          scored.contractId,
          exactMetrics(scored.metrics),
          'Choice representation differed from its technology-neutral ground truth.',
        ),
      ),
      task(
        'choice/equivalence',
        new Set(choiceScores.map(caseFingerprint)).size === 1,
        'Equivalent choice technologies produced different semantic facts.',
      ),
      task(
        'relationships/exact-cross-tree-and-abstention',
        exactMetrics(relationshipScore.metrics),
        'Label relationships or ambiguous-label abstention differed from ground truth.',
      ),
      task(
        'table-grid/native-aria-nested-actions',
        exactMetrics(tableScore.metrics),
        'Table/grid structure or nested action facts differed from ground truth.',
      ),
      task(
        'identity/stable-rerender',
        identityStability.rate === 1 &&
          identityStability.changed === 0 &&
          identityStability.missing === 0,
        'Stable business identities changed or disappeared across a node replacement.',
      ),
      task(
        'identity/recycled-record-replaced',
        recycledWasReplaced,
        'A recycled DOM row retained the prior business record identity.',
      ),
      task(
        'omissions/scan-cap-exact',
        omissionAccounting.exact,
        'The scan-cap omissions did not exactly match known omitted facts.',
      ),
      task(
        'release-gate/representation',
        releaseGate.passed,
        releaseGate.failures.join(' '),
      ),
    ];
    const payloadMeasurementSource = payloads.join('');
    const modelPayloadNdjson = `${payloads.join('\n')}\n`;
    const report = createEvaluationReport({
      runId: options.runId ?? defaultRunId(),
      ...(options.environmentFingerprint === undefined
        ? {}
        : { environmentFingerprint: options.environmentFingerprint }),
      metadata: {
        suite: 'browserir-representation-ground-truth',
        corpusVersion: 1,
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
        releaseGate,
        releaseReady:
          releaseGate.passed && tasks.every((candidate) => candidate.outcome === 'passed'),
        scenarioOrder: [...REPRESENTATION_SCENARIO_IDS],
        modelPayloads: scenarios,
        payloadMeasurement:
          'Exact concatenation of each {text,structured} payload, excluding NDJSON delimiters.',
        recycledIdentity: {
          priorIds: stableIdentity.map(({ entityId }) => entityId),
          currentIds: recycledIds,
          allReplaced: recycledWasReplaced,
        },
        omissionGroundTruth: knownOmissions,
      },
      tasks,
      representation,
      payload: measurePayload(payloadMeasurementSource),
    });
    return {
      report,
      releaseGate,
      releaseReady:
        releaseGate.passed && tasks.every((candidate) => candidate.outcome === 'passed'),
      scenarios,
      modelPayloadNdjson,
    };
  } finally {
    if (browserId !== undefined) {
      await runtime.close({ browserId }).catch(() => {});
    }
    await fixture.close().catch(() => {});
  }
}

export async function writeRepresentationArtifacts(
  outputDirectory: string,
  result: RepresentationGroundTruthSuiteResult,
): Promise<RepresentationArtifactPaths> {
  await mkdir(outputDirectory, { recursive: true });
  const paths: RepresentationArtifactPaths = {
    json: join(outputDirectory, 'representation-report.json'),
    ndjson: join(outputDirectory, 'representation-report.ndjson'),
    markdown: join(outputDirectory, 'representation-report.md'),
    junit: join(outputDirectory, 'representation-report.junit.xml'),
    payloadNdjson: join(outputDirectory, 'model-payload.ndjson'),
  };
  const artifacts: readonly [string, string][] = [
    [paths.json, renderEvaluationJson(result.report)],
    [paths.ndjson, renderEvaluationNdjson(result.report)],
    [paths.markdown, renderEvaluationMarkdown(result.report)],
    [paths.junit, renderEvaluationJUnit(result.report)],
    [paths.payloadNdjson, result.modelPayloadNdjson],
  ];
  const created: string[] = [];
  try {
    for (const [path, content] of artifacts) {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      created.push(path);
    }
    return paths;
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
}
