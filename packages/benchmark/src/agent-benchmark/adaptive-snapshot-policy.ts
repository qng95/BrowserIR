import type { AgentToolCallResult, AgentToolContentBlock } from './contracts.js';
import {
  isPlaywrightSnapshotDescendant,
  parsePlaywrightSnapshotNodes,
  type PlaywrightSnapshotBox,
  type PlaywrightSnapshotNode,
} from './playwright-snapshot-document.js';

export const ADAPTIVE_SNAPSHOT_POLICY_VERSION = 'adaptive-snapshot-policy/1' as const;
export const PLAYWRIGHT_GEOMETRY_FEATURE = 'geometry' as const;

export type AdaptiveSnapshotDecision =
  | { kind: 'not-applicable'; code: string }
  | { kind: 'sufficient'; code: string }
  | { kind: 'require'; code: string; feature: typeof PLAYWRIGHT_GEOMETRY_FEATURE };

export interface AdaptiveSnapshotPolicyContext {
  snapshotTree: string;
}

export interface AdaptiveSnapshotProjectionContext {
  feature: typeof PLAYWRIGHT_GEOMETRY_FEATURE;
  baselineSnapshotTree: string;
  featureSnapshotTree: string;
}

export interface AdaptiveStructuralFact {
  kind: string;
  ref: string;
  attributes: Readonly<Record<string, string>>;
}

export interface AdaptiveStructuralSupplement {
  schema: string;
  facts: readonly AdaptiveStructuralFact[];
}

export interface AdaptiveSnapshotProjection {
  kind: 'resolved' | 'unresolved';
  code: string;
  supplement?: AdaptiveStructuralSupplement | undefined;
}

export interface AdaptiveSnapshotPolicy {
  id: string;
  version: string;
  reasonCodes: readonly string[];
  evaluate(context: AdaptiveSnapshotPolicyContext): AdaptiveSnapshotDecision;
  project(context: AdaptiveSnapshotProjectionContext):
    | AdaptiveSnapshotProjection
    | Promise<AdaptiveSnapshotProjection>;
}

const normalized = (value: string): string =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function replaceAgentToolResultText(
  result: AgentToolCallResult,
  text: string,
): AgentToolCallResult {
  if (result.content === undefined) return { ...result, text };
  const unseenText = result.content.flatMap((block) =>
    block.type === 'text' && block.text.length > 0 && !result.text.includes(block.text)
      ? [block.text]
      : []);
  const completeText = unseenText.length === 0 ? text : `${text}\n\n${unseenText.join('\n\n')}`;
  const content: AgentToolContentBlock[] = [{ type: 'text', text: completeText }];
  for (const block of result.content) {
    if (block.type !== 'text') content.push(block);
  }
  return { ...result, text: completeText, content };
}

interface GridAnalysis {
  route: 'sufficient' | 'geometry';
  nodes: readonly PlaywrightSnapshotNode[];
  grid: PlaywrightSnapshotNode;
  rows: readonly (PlaywrightSnapshotNode & { name: string })[];
  columns: readonly (PlaywrightSnapshotNode & { name: string })[];
  candidates: readonly (PlaywrightSnapshotNode & { name: string; ref: string })[];
}

const labelOccurs = (name: string, label: string): boolean => {
  const haystack = ` ${normalized(name).toLocaleLowerCase('en-US')} `;
  const needle = ` ${normalized(label).toLocaleLowerCase('en-US')} `;
  return haystack.includes(needle);
};

const exactUniqueNamed = (
  nodes: readonly PlaywrightSnapshotNode[],
): Array<PlaywrightSnapshotNode & { name: string }> | undefined => {
  const seen = new Set<string>();
  const retained: Array<PlaywrightSnapshotNode & { name: string }> = [];
  for (const node of nodes) {
    if (node.name === undefined || node.name.length === 0) return undefined;
    const key = normalized(node.name).toLocaleLowerCase('en-US');
    if (seen.has(key)) return undefined;
    seen.add(key);
    retained.push(node as PlaywrightSnapshotNode & { name: string });
  }
  return retained;
};

const nearestAncestorWithRole = (
  nodes: readonly PlaywrightSnapshotNode[],
  candidate: PlaywrightSnapshotNode,
  roles: ReadonlySet<string>,
): PlaywrightSnapshotNode | undefined => {
  let parent = candidate.parentIndex;
  while (parent !== undefined) {
    const node = nodes[parent];
    if (node === undefined) return undefined;
    if (roles.has(node.role)) return node;
    parent = node.parentIndex;
  }
  return undefined;
};

const completeCoordinates = (
  candidates: readonly (PlaywrightSnapshotNode & { name: string; ref: string })[],
  rows: readonly (PlaywrightSnapshotNode & { name: string })[],
  columns: readonly (PlaywrightSnapshotNode & { name: string })[],
): boolean => {
  const coordinates = candidates.flatMap(({ name }) => {
    const matchingRows = rows.filter((row) => labelOccurs(name, row.name));
    const matchingColumns = columns.filter((column) => labelOccurs(name, column.name));
    return matchingRows.length === 1 && matchingColumns.length === 1
      ? [`${matchingRows[0]!.name}\u0000${matchingColumns[0]!.name}`]
      : [];
  });
  const expected = rows.flatMap((row) =>
    columns.map((column) => `${row.name}\u0000${column.name}`));
  return coordinates.length === candidates.length &&
    new Set(coordinates).size === expected.length &&
    [...coordinates].sort(compareStrings).join('\u0001') ===
      [...expected].sort(compareStrings).join('\u0001');
};

function analyzeGridSnapshot(
  snapshotTree: string,
  limits: Readonly<{ maxRows: number; maxColumns: number }>,
): GridAnalysis | undefined {
  const nodes = parsePlaywrightSnapshotNodes(snapshotTree);
  const grids = nodes.filter(({ role }) => role === 'grid');
  if (grids.length !== 1) return undefined;
  const buttons = nodes.filter(
    (node): node is PlaywrightSnapshotNode & { name: string; ref: string } =>
      node.role === 'button' && node.name !== undefined && node.ref !== undefined,
  );
  const matches: GridAnalysis[] = [];
  const gridRoles = new Set(['grid']);
  for (const grid of grids) {
    const descendants = nodes.filter((node) =>
      isPlaywrightSnapshotDescendant(nodes, node.index, grid.index) &&
      nearestAncestorWithRole(nodes, node, gridRoles)?.index === grid.index);
    const rows = exactUniqueNamed(descendants.filter(({ role }) => role === 'rowheader'));
    const columns = exactUniqueNamed(descendants.filter(({ role }) => role === 'columnheader'));
    if (
      rows === undefined || columns === undefined ||
      rows.length < 2 || rows.length > limits.maxRows ||
      columns.length < 2 || columns.length > limits.maxColumns
    ) continue;
    const expectedCount = rows.length * columns.length;
    const semanticCandidates = buttons.filter(({ name }) => {
      const rowMatches = rows.filter((row) => labelOccurs(name, row.name));
      const columnMatches = columns.filter((column) => labelOccurs(name, column.name));
      return rowMatches.length === 1 && columnMatches.length === 1;
    });
    const semanticComplete =
      semanticCandidates.length === expectedCount &&
      completeCoordinates(semanticCandidates, rows, columns);
    const groups = new Map<string, Array<PlaywrightSnapshotNode & { name: string; ref: string }>>();
    for (const button of buttons) {
      const key = normalized(button.name).toLocaleLowerCase('en-US');
      const group = groups.get(key) ?? [];
      group.push(button);
      groups.set(key, group);
    }
    const ambiguousGroups = [...groups.values()].filter((group) =>
      group.length === expectedCount &&
      new Set(group.map(({ ref }) => ref)).size === expectedCount);
    if (semanticComplete && ambiguousGroups.length === 0) {
      matches.push({
        route: 'sufficient', nodes, grid, rows, columns, candidates: semanticCandidates,
      });
    } else if (!semanticComplete && ambiguousGroups.length === 1) {
      matches.push({
        route: 'geometry',
        nodes,
        grid,
        rows,
        columns,
        candidates: ambiguousGroups[0]!,
      });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

const centerWithin = (
  candidate: PlaywrightSnapshotBox,
  header: PlaywrightSnapshotBox,
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const center = candidate[axis] + candidate[size] / 2;
  return center >= header[axis] && center < header[axis] + header[size];
};

const boxInside = (inner: PlaywrightSnapshotBox, outer: PlaywrightSnapshotBox): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const bandsDoNotOverlap = (
  boxes: readonly PlaywrightSnapshotBox[],
  axis: 'x' | 'y',
): boolean => {
  const size = axis === 'x' ? 'width' : 'height';
  const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
  return ordered.every((box, index) =>
    index === 0 || ordered[index - 1]![axis] + ordered[index - 1]![size] <= box[axis]);
};

export interface GridCoordinateFact {
  kind: 'grid-cell';
  ref: string;
  row: string;
  column: string;
}

function projectGridFacts(analysis: GridAnalysis): readonly GridCoordinateFact[] | undefined {
  if (analysis.grid.box === undefined) return undefined;
  const rows = analysis.rows.filter(
    (node): node is typeof node & { box: PlaywrightSnapshotBox } => node.box !== undefined,
  );
  const columns = analysis.columns.filter(
    (node): node is typeof node & { box: PlaywrightSnapshotBox } => node.box !== undefined,
  );
  const candidates = analysis.candidates.filter(
    (node): node is typeof node & { box: PlaywrightSnapshotBox } => node.box !== undefined,
  );
  if (
    rows.length !== analysis.rows.length ||
    columns.length !== analysis.columns.length ||
    candidates.length !== analysis.candidates.length
  ) return undefined;
  const rowAncestors = rows.map((row) =>
    nearestAncestorWithRole(analysis.nodes, row, new Set(['row']))?.index);
  const columnAncestors = columns.map((column) =>
    nearestAncestorWithRole(analysis.nodes, column, new Set(['row']))?.index);
  if (
    rowAncestors.some((index) => index === undefined) ||
    new Set(rowAncestors).size !== rows.length ||
    columnAncestors.some((index) => index === undefined) ||
    new Set(columnAncestors).size !== 1 ||
    !bandsDoNotOverlap(rows.map(({ box }) => box), 'y') ||
    !bandsDoNotOverlap(columns.map(({ box }) => box), 'x') ||
    ![...rows, ...columns, ...candidates].every(({ box }) =>
      boxInside(box, analysis.grid.box!))
  ) return undefined;
  const facts = candidates.flatMap((candidate): GridCoordinateFact[] => {
    const matchingRows = rows.filter((row) => centerWithin(candidate.box, row.box, 'y'));
    const matchingColumns = columns.filter((column) =>
      centerWithin(candidate.box, column.box, 'x'));
    return matchingRows.length === 1 && matchingColumns.length === 1
      ? [{
          kind: 'grid-cell',
          ref: candidate.ref,
          row: matchingRows[0]!.name,
          column: matchingColumns[0]!.name,
        }]
      : [];
  });
  const expectedCount = rows.length * columns.length;
  const coordinates = facts.map(({ row, column }) => `${row}\u0000${column}`);
  if (
    facts.length !== expectedCount ||
    new Set(facts.map(({ ref }) => ref)).size !== expectedCount ||
    new Set(coordinates).size !== expectedCount
  ) return undefined;
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
}

export interface GridCoordinateSnapshotPolicyOptions {
  maxRows?: number | undefined;
  maxColumns?: number | undefined;
}

/**
 * First narrow structural plugin: complete grid-coordinate bindings. It is
 * task/query independent and emits no recommendation or selected target.
 */
export function createGridCoordinateSnapshotPolicy(
  options: GridCoordinateSnapshotPolicyOptions = {},
): AdaptiveSnapshotPolicy {
  const limits = {
    maxRows: options.maxRows ?? 12,
    maxColumns: options.maxColumns ?? 12,
  };
  if (
    !Number.isInteger(limits.maxRows) || limits.maxRows < 2 || limits.maxRows > 32 ||
    !Number.isInteger(limits.maxColumns) || limits.maxColumns < 2 || limits.maxColumns > 32
  ) throw new Error('Grid-coordinate policy limits must be integers from 2 through 32.');
  if (limits.maxRows * limits.maxColumns > 256) {
    throw new Error('Grid-coordinate policy v1 permits at most 256 projected cells.');
  }

  return Object.freeze({
    id: 'grid-coordinate',
    version: 'grid-coordinate-policy/1',
    reasonCodes: Object.freeze([
      'no-unique-grid-coordinate-context',
      'complete-coordinate-binding-proven',
      'complete-coordinate-binding-needs-geometry',
      'complete-coordinate-binding-unresolved',
      'complete-coordinate-binding-projected',
    ]),
    evaluate(context: AdaptiveSnapshotPolicyContext): AdaptiveSnapshotDecision {
      const analysis = analyzeGridSnapshot(context.snapshotTree, limits);
      if (analysis === undefined) {
        return { kind: 'not-applicable', code: 'no-unique-grid-coordinate-context' };
      }
      return analysis.route === 'sufficient'
        ? { kind: 'sufficient', code: 'complete-coordinate-binding-proven' }
        : {
            kind: 'require',
            code: 'complete-coordinate-binding-needs-geometry',
            feature: PLAYWRIGHT_GEOMETRY_FEATURE,
          };
    },
    project(context: AdaptiveSnapshotProjectionContext): AdaptiveSnapshotProjection {
      const analysis = analyzeGridSnapshot(context.featureSnapshotTree, limits);
      const facts = analysis === undefined ? undefined : projectGridFacts(analysis);
      if (facts === undefined) {
        return {
          kind: 'unresolved',
          code: 'complete-coordinate-binding-unresolved',
        };
      }
      return {
        kind: 'resolved',
        code: 'complete-coordinate-binding-projected',
        supplement: {
          schema: 'grid-coordinate/1',
          facts: facts.map(({ ref, row, column }) => ({
            kind: 'grid-cell',
            ref,
            attributes: { row, column },
          })),
        },
      };
    },
  });
}
